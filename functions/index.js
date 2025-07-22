// ===============================================
//  Google Calendar Automation Backend (v2)
//  Updated to support agent-passed config variables
// ===============================================

const { google } = require('googleapis');
const express    = require('express');
const bodyParser = require('body-parser');
const cors       = require('cors');
const { DateTime } = require('luxon');

// Default fallback config (used if not provided by agent)
const DEFAULTS = {
  timezone: 'America/Vancouver',
  officeStart: 9,          // 9 AM
  officeEnd: 17,           // 5 PM
  durationMin: 60,         // appointment length (min)
  maxOverlaps: 5           // max simultaneous events
};

// Google Auth
const auth = new google.auth.GoogleAuth({
  keyFile: '/etc/secrets/upreach-key.json',
  scopes: ['https://www.googleapis.com/auth/calendar']
});
const calendar = google.calendar({ version: 'v3', auth });

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Route entry
app.post('/action', async (req, res) => {
  const data   = req.body;
  const action = (data.action || '').toLowerCase();

  try {
    if (action === 'book')       return book(data, res);
    if (action === 'cancel')     return cancel(data, res);
    if (action === 'findnearest') return findNearest(data, res);

    return res.json({ status:'error', message:`Unknown action "${data.action}"` });
  } catch (err) {
    console.error(err);
    return res.json({ status:'error', message:err.message });
  }
});

// Format UTC date to ISO string with local offset
function toLocalISOString(date) {
  const offsetMinutes = date.getTimezoneOffset();
  const localMs = date.getTime() - offsetMinutes*60000;
  const baseIso = new Date(localMs).toISOString().slice(0, -1);
  const sign = offsetMinutes > 0 ? '-' : '+';
  const abs  = Math.abs(offsetMinutes);
  const h    = String(Math.floor(abs/60)).padStart(2, '0');
  const m    = String(abs % 60).padStart(2, '0');
  return `${baseIso}${sign}${h}:${m}`;
}

// BOOK APPOINTMENT
async function book(data, res) {
  const { name, email, phone, bookingTime, calendarId, blockingCalendarId, appointmentType } = data;
  if (!name || !bookingTime || !calendarId) {
    return res.json({ status:'error', message:'Missing name, calendarId or bookingTime' });
  }

  const timezone    = data.timezone || DEFAULTS.timezone;
  const officeStart = data.officeStart ?? DEFAULTS.officeStart;
  const officeEnd   = data.officeEnd ?? DEFAULTS.officeEnd;
  const durationMin = (data.durationMin || DEFAULTS.durationMin);
  const maxOverlaps = (data.maxOverlaps || DEFAULTS.maxOverlaps);

  const blockingId = blockingCalendarId || calendarId;

  const startLux = DateTime.fromISO(bookingTime, { zone: timezone });
  const endLux   = startLux.plus({ minutes: durationMin });
  const h0 = startLux.hour, h1 = endLux.hour, m1 = endLux.minute;

  if (h0 < officeStart || h1 > officeEnd || (h1 === officeEnd && m1 > 0)) {
    return res.json({ status: 'rejected', reason: 'outside_office_hours' });
  }

  const start = new Date(startLux.toUTC().toISO());
  const end   = new Date(endLux.toUTC().toISO());

  const fb = await calendar.freebusy.query({
    requestBody: {
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      items: [
        { id: calendarId },
        { id: blockingId }
      ]
    }
  });

  const busyBlock = fb.data.calendars[blockingId]?.busy || [];
  if (busyBlock.length > 0) {
    return res.json({ status:'rejected', reason:'slot_blocked' });
  }

  const busyMain = fb.data.calendars[calendarId]?.busy || [];
  if (busyMain.length >= maxOverlaps) {
    return res.json({ status:'rejected', reason:'slot_full' });
  }

  const event = {
    summary:     `Appointment with ${name}`,
    description: `Email: ${email||'N/A'}\nPhone: ${phone||'N/A'}`,
    start:       { dateTime: start.toISOString() },
    end:         { dateTime: end.toISOString() },
    location:    `Phone: ${phone||''}`
  };

  const inserted = await calendar.events.insert({
    calendarId,
    resource: event
  });

  return res.json({
    status: 'success',
    results: {
      status: 'booked',
      data: {
        eventId: inserted.data.id,
        start: toLocalISOString(start),
        end:   toLocalISOString(end)
      }
    }
  });
}

// CANCEL APPOINTMENT
async function cancel(data, res) {
  const { name, email, phone, calendarId } = data;
  if (!name || (!email && !phone) || !calendarId) {
    return res.json({ status:'error', message:'Missing credentials or calendarId' });
  }

  const now = new Date();
  const future = new Date(now.getTime() + 30*24*60*60000);

  const list = await calendar.events.list({
    calendarId,
    timeMin: now.toISOString(),
    timeMax: future.toISOString(),
    singleEvents: true
  });

  const lower = name.toLowerCase();
  for (let ev of list.data.items || []) {
    if (!ev.summary.toLowerCase().includes(lower)) continue;
    const desc = (ev.description || '').toLowerCase();
    if (email && !desc.includes(email.toLowerCase())) continue;
    if (phone && !desc.includes(phone)) continue;

    await calendar.events.delete({ calendarId, eventId: ev.id });
    return res.json({
      status: 'success',
      results: {
        status: 'cancelled',
        data: { start: toLocalISOString(new Date(ev.start.dateTime)) }
      }
    });
  }

  return res.json({ status:'not_found', message:'No matching appointment' });
}

// FIND NEAREST SLOT
async function findNearest(data, res) {
  const { bookingTime, calendarId, blockingCalendarId } = data;
  if (!calendarId || !bookingTime) {
    return res.json({ status:'error', message:'Missing calendarId or bookingTime' });
  }

  const timezone    = data.timezone || DEFAULTS.timezone;
  const officeStart = data.officeStart ?? DEFAULTS.officeStart;
  const officeEnd   = data.officeEnd ?? DEFAULTS.officeEnd;
  const durationMin = data.durationMin || DEFAULTS.durationMin;
  const maxOverlaps = data.maxOverlaps || DEFAULTS.maxOverlaps;
  const blockingId  = blockingCalendarId || calendarId;

  const wanted = DateTime.fromISO(bookingTime, { zone: timezone });
  const slotMs = durationMin * 60000;
  const step   = 15 * 60000;
  const window = 8 * 60 * 60000;

  let best = null;

  for (let delta = 0; delta <= window; delta += step) {
    for (let dir of [ -1, +1 ]) {
      const startLux = wanted.plus({ milliseconds: dir * delta });
      const endLux = startLux.plus({ minutes: durationMin });
      const h0 = startLux.hour, h1 = endLux.hour, m1 = endLux.minute;
      if (h0 < officeStart || h1 > officeEnd || (h1 === officeEnd && m1 > 0)) continue;

      const start = new Date(startLux.toUTC().toISO());
      const end   = new Date(endLux.toUTC().toISO());

      const fb = await calendar.freebusy.query({
        requestBody: {
          timeMin: start.toISOString(),
          timeMax: end.toISOString(),
          items: [{ id: blockingId }]
        }
      });

      if ((fb.data.calendars[blockingId]?.busy || []).length > 0) continue;

      const list = await calendar.events.list({
        calendarId,
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        singleEvents: true
      });

      if ((list.data.items || []).length < maxOverlaps) {
        best = { start, end, direction: dir > 0 ? 'after' : 'before' };
        break;
      }
    }
    if (best) break;
  }

  if (!best) {
    return res.json({ status:'not_found', message:'No slot found' });
  }

  return res.json({
    status: 'success',
    results: {
      status: 'available',
      data: {
        start: toLocalISOString(best.start),
        end: toLocalISOString(best.end),
        direction: best.direction
      }
    }
  });
}

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
