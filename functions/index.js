const { google } = require('googleapis');
const express    = require('express');
const bodyParser = require('body-parser');
const cors       = require('cors');

const OFFICE_START = 9;    // 9 AM
const OFFICE_END   = 17;   // 5 PM
const DURATION_MIN = 60;   // Appointment length (minutes)
const MAX_OVERLAPS = 5;    // Max simultaneous events

const CALENDAR_ID          = process.env.CALENDAR_ID;
const BLOCKING_CALENDAR_ID = process.env.BLOCKING_CALENDAR_ID || CALENDAR_ID;

//
// — GoogleAuth using the secret file Render mounts at /etc/secrets
//
const auth = new google.auth.GoogleAuth({
  keyFile: '/etc/secrets/upreach-key.json',
  scopes: ['https://www.googleapis.com/auth/calendar']
});
const calendar = google.calendar({ version: 'v3', auth });

const app = express();
app.use(cors());
app.use(bodyParser.json());

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


//
// Helpers
//
function toLocalISOString(date) {
  const offsetMinutes = date.getTimezoneOffset();
  // shift to local time
  const localMs = date.getTime() - offsetMinutes*60000;
  // build an ISO string *without* the trailing "Z"
  const baseIso = new Date(localMs).toISOString().slice(0, -1);

  // build the ±HH:MM offset
  const sign = offsetMinutes > 0 ? '-' : '+';
  const abs  = Math.abs(offsetMinutes);
  const h    = String(Math.floor(abs/60)).padStart(2, '0');
  const m    = String(abs % 60).padStart(2, '0');

  return `${baseIso}${sign}${h}:${m}`;
}

//
// — BOOK
//
async function book(data, res) {
  const { name, email, phone, bookingTime } = data;
  if (!name || !bookingTime) {
    return res.json({ status:'error', message:'Missing name or bookingTime' });
  }

  const start = new Date(bookingTime);
  const end   = new Date(start.getTime() + DURATION_MIN*60000);

  // office‐hours check
  const h0 = start.getHours(), h1 = end.getHours(), m1 = end.getMinutes();
  if (h0 < OFFICE_START || h1 > OFFICE_END || (h1===OFFICE_END && m1>0)) {
    return res.json({ status:'rejected', reason:'outside_office_hours' });
  }

  // freebusy on both calendars
  const fb = await calendar.freebusy.query({
    requestBody:{
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      items: [
        { id: CALENDAR_ID },
        { id: BLOCKING_CALENDAR_ID }
      ]
    }
  });

  const busyBlock = fb.data.calendars[BLOCKING_CALENDAR_ID]?.busy || [];
  if (busyBlock.length>0) {
    return res.json({ status:'rejected', reason:'slot_blocked' });
  }

  const busyMain = fb.data.calendars[CALENDAR_ID]?.busy || [];
  if (busyMain.length >= MAX_OVERLAPS) {
    return res.json({ status:'rejected', reason:'slot_full' });
  }

  // build event
  const event = {
    summary:     `Appointment with ${name}`,
    description: `Email: ${email||'N/A'}\nPhone: ${phone||'N/A'}`,
    start:       { dateTime: start.toISOString() },
    end:         { dateTime: end.toISOString() },
    location:    `Phone: ${phone||''}`
  };

  if (email && email.includes('@')) {
    event.attendees    = [{ email }];
    event.sendUpdates  = 'all';
  }

  const inserted = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    resource:   event
  });

  return res.json({
    status:'success',
    results:{
      status:'booked',
      data:{
        eventId: inserted.data.id,
        start:   toLocalISOString(start),
        end:     toLocalISOString(end)
      }
    }
  });
}

//
// — CANCEL
//
async function cancel(data, res) {
  const { name, email, phone } = data;
  if (!name || (!email && !phone)) {
    return res.json({ status:'error', message:'Need name + (email or phone)' });
  }

  // next 30 days
  const now    = new Date(),
        future = new Date(now.getTime() + 30*24*60*60000);

  const list = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin:    now.toISOString(),
    timeMax:    future.toISOString(),
    singleEvents: true
  });

  const lower = name.toLowerCase();
  for (let ev of list.data.items||[]) {
    if (!ev.summary.toLowerCase().includes(lower)) continue;
    const desc = (ev.description||'').toLowerCase();
    if (email && !desc.includes(email.toLowerCase())) continue;
    if (phone && !desc.includes(phone)) continue;

    // delete it
    await calendar.events.delete({
      calendarId: CALENDAR_ID,
      eventId:    ev.id
    });
    return res.json({
      status:'success',
      results:{
        status:'cancelled',
        data:{ start: toLocalISOString(new Date(ev.start.dateTime)) }
      }
    });
  }

  return res.json({ status:'not_found', message:'No matching appointment' });
}

//
// — FIND NEAREST
//
async function findNearest(data, res) {
  const wanted = new Date(data.bookingTime);
  const slotMs = DURATION_MIN*60000;
  const step   = 15*60000;
  const window = 8*60*60000;

  let best = null;

  for (let delta=0; delta<=window; delta+=step) {
    for (let dir of [ -1, +1 ]) {
      const start = new Date(wanted.getTime()+dir*delta);
      const end   = new Date(start.getTime()+slotMs);

      const h0=start.getHours(), h1=end.getHours(), m1=end.getMinutes();
      if (h0<OFFICE_START || h1>OFFICE_END || (h1===OFFICE_END&&m1>0)) continue;

      const fb = await calendar.freebusy.query({
        requestBody:{
          timeMin:start.toISOString(),
          timeMax:end.toISOString(),
          items:[{id:BLOCKING_CALENDAR_ID}]
        }
      });

      if ((fb.data.calendars[BLOCKING_CALENDAR_ID]?.busy||[]).length>0) continue;

      const list = await calendar.events.list({
        calendarId:    CALENDAR_ID,
        timeMin:       start.toISOString(),
        timeMax:       end.toISOString(),
        singleEvents:  true
      });

      if ((list.data.items||[]).length < MAX_OVERLAPS) {
        best = { start, end, direction: dir>0?'after':'before' };
        break;
      }
    }
    if (best) break;
  }

  if (!best) {
    return res.json({ status:'not_found', message:'No slot found' });
  }

  return res.json({
    status:'success',
    results:{
      status:'available',
      data:{
        start:     toLocalISOString(best.start),
        end:       toLocalISOString(best.end),
        direction: best.direction
      }
    }
  });
}


// start the server
const PORT = process.env.PORT||3000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
