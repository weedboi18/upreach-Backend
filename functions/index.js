// ===============================================
//  Google Calendar Automation Backend (v2)
//  Updated to support agent-passed config variables
// ===============================================
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // Use service role for server
const supabase = createClient(supabaseUrl, supabaseKey);
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
app.post("/stats", async (req, res) => {
  const { business_id } = req.body;
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY); // use service key to bypass RLS safely

  const { data, error } = await supabase
    .from("stats")
    .select("*")
    .eq("business_id", business_id);

  if (error) {
    console.error("Supabase error:", error);
    return res.status(500).json({ error: "Failed to fetch stats" });
  }

  // Example aggregation
  const total_calls = data.length;
  const total_bookings = data.filter(row => row.call_type === "booked").length;
  const total_rejected = data.filter(row => row.call_type === "rejected").length;

  return res.json({
    total_calls,
    total_bookings,
    total_rejected,
  });
});
const app = express();
app.use(cors());
app.use(bodyParser.json());
app.post('/onboard', async (req, res) => {
  const data = req.body;
  const businessId = data.business_id; // coming from Synthflow
    if (!businessId) {
      return res.status(400).json({ status: 'error', message: 'Missing business_id' });
    }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // 1. Get the logged-in user from the access token
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Missing auth token' });
  }

  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData.user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const uid = userData.user.id;

  // 2. Extract business info from form
  const { business_id, name, email } = data;
  if (!business_id || !name || !email) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // 3. Insert business row
  const { error: insertError } = await supabase.from('businesses').insert([
    {
      id: uid,
      business_id,
      name,
      email,
    },
  ]);

  if (insertError) {
    return res.status(400).json({ error: insertError.message });
  }

  return res.json({ success: true, uid });
});

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
    await supabase.from('stats').insert([{
      business_id: businessId,
      call_type: 'rejected',
      phone: data.phone,
      metadata: {
        name: data.name,
        email: data.email,
        reason: "outside_office_hours"
      }
    }]);

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
    await supabase.from('stats').insert([{
      business_id: businessId,
      call_type: 'rejected',
      phone: data.phone,
      metadata: {
        name: data.name,
        email: data.email,
        reason: "slot_blocked"
      }
    }]);
    return res.json({ status:'rejected', reason:'slot_blocked' });
  }

  const busyMain = fb.data.calendars[calendarId]?.busy || [];
  if (busyMain.length >= maxOverlaps) {
    if (busyBlock.length > 0) {
    await supabase.from('stats').insert([{
      business_id: businessId,
      call_type: 'rejected',
      phone: data.phone,
      metadata: {
        name: data.name,
        email: data.email,
        reason: "slot_full"
      }
    }]);
    return res.json({ status:'rejected', reason:'slot_full' });
  }

  const event = {
    summary: `Appointment with (${name})`,
    description: `Email: ${email||'N/A'}\nPhone: ${phone||'N/A'}`,
    start:       { dateTime: start.toISOString() },
    end:         { dateTime: end.toISOString() },
    location:    `Phone: ${phone||''}`
  };

  const inserted = await calendar.events.insert({
    calendarId,
    resource: event
  });
  await supabase.from('stats').insert([{
    business_id: businessId,
    call_type: 'booking',
    phone: data.phone,
    appointment_id: inserted.data.id,
    metadata: { name: data.name, email: data.email }
  }]);

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
}

// Modified CANCEL function using Supabase to identify the appointment
async function cancel(data, res) {
  const { name, email, phone, calendarId, business_id } = data;
  if (!name || (!email && !phone) || !calendarId || !business_id) {
    return res.json({ status: 'error', message: 'Missing required fields' });
  }

  // Step 1: Find matching appointment from Supabase logs
  const { data: matchingStats, error } = await supabase
    .from('stats')
    .select('appointment_id, metadata')
    .eq('business_id', business_id)
    .eq('call_type', 'booking')
    .order('created_at', { ascending: false })
    .limit(20);

  if (error || !matchingStats || matchingStats.length === 0) {
    return res.json({ status: 'not_found', message: 'No recent appointments found' });
  }

  const match = matchingStats.find(entry => {
    const meta = entry.metadata || {};
    const nameMatch = (meta.name || '').toLowerCase() === name.toLowerCase();
    const emailMatch = email ? (meta.email || '').toLowerCase() === email.toLowerCase() : true;
    const phoneMatch = phone ? (data.phone === phone) : true;
    return nameMatch && emailMatch && phoneMatch;
  });

  if (!match) {
    return res.json({ status: 'not_found', message: 'No matching appointment' });
  }

  // Step 2: Delete the event using appointment_id
  try {
    await calendar.events.delete({ calendarId, eventId: match.appointment_id });
    return res.json({
      status: 'success',
      results: {
        status: 'cancelled',
        data: { appointment_id: match.appointment_id }
      }
    });
  } catch (err) {
    console.error('Failed to delete calendar event:', err);
    return res.json({ status: 'error', message: 'Failed to cancel appointment' });
  }
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
