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
  durationMin: 15,         // appointment length (min)
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
app.post("/stats", async (req, res) => {
  const { business_id } = req.body;
  const supabase = createClient(supabaseUrl, supabaseKey);

  const { data, error } = await supabase
    .from("stats")
    .select("*")
    .eq("business_id", business_id);

  if (error) {
    console.error("Supabase error:", error);
    return res.status(500).json({ error: "Failed to fetch stats" });
  }

  const now = DateTime.now();
  const total_calls = data.length;
  const total_bookings = data.filter(row => row.call_type === "booking").length;
  const total_rejected = data.filter(row => row.call_type === "rejected").length;

  const daily = data.filter(row =>
    row.call_type === "booking" &&
    DateTime.fromISO(row.timestamp).diff(now, 'days').days >= -1
  ).length;

  const weekly = data.filter(row =>
    row.call_type === "booking" &&
    DateTime.fromISO(row.timestamp).diff(now, 'days').days >= -7
  ).length;

  const monthly = data.filter(row =>
    row.call_type === "booking" &&
    DateTime.fromISO(row.timestamp).diff(now, 'days').days >= -30
  ).length;

  return res.json({
    total_calls,
    total_bookings,
    total_rejected,
    daily_bookings: daily,
    weekly_bookings: weekly,
    monthly_bookings: monthly
  });
});
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
// ==== deps at top of file (reuse your existing ones) ====


const { createClient } = require('@supabase/supabase-js');




// TODO: wire to your existing Google Calendar helpers
async function gcalHasOverlap(calendarId, startIso, endIso) { /* ... */ }
async function gcalCreateEvent(calendarId, { summary, description, start, end, timezone }) { /* ... */ }

// ---------- helpers ----------
function sayTimeLocal(iso, tz) {
  return DateTime.fromISO(iso, { setZone: true })
    .setZone(tz)
    .toLocaleString({ weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

// Accept either the public text code or a uuid; return both if possible
async function resolveBusiness(reqBody) {
  const business_code = reqBody.business_code || reqBody.business_id || null; // agent's public string
  const business_uuid = reqBody.business_uuid || null;

  if (business_uuid) {
    // We also try to fetch the code for stats if you want it later
    const { data: b } = await supabase
      .from('businesses')
      .select('id, business_id')
      .eq('id', business_uuid)
      .maybeSingle();
    return { bizUuid: business_uuid, bizCode: b?.business_id || business_code || null };
  }

  if (!business_code) throw new Error('BUSINESS_MISSING');

  const { data: b, error } = await supabase
    .from('businesses')
    .select('id, business_id')
    .eq('business_id', business_code)
    .single();

  if (error || !b) throw new Error('BUSINESS_NOT_FOUND');
  return { bizUuid: b.id, bizCode: b.business_id };
}

// Try each active car of a model until insert succeeds (DB enforces real overlaps)
async function tryInsertForAnyCarOfModel(bizUuid, model, startUtc, endUtc, payloadBase) {
  const { data: cars, error } = await supabase
    .from('cars')
    .select('id')
    .eq('business_id', bizUuid)
    .eq('is_active', true)
    .ilike('model', model);

  if (error || !cars || cars.length === 0) return { ok: false, reason: 'NO_CAR_OF_MODEL' };

  for (const c of cars) {
    const ins = await supabase
      .from('appointments')
      .insert([{ ...payloadBase, car_id: c.id }])
      .select('id')
      .single();

    if (!ins.error) return { ok: true, apptId: ins.data.id, carId: c.id };

    const em = String(ins.error.message || '');
    if (em.includes('ex_no_overlap_per_car') || em.includes('capacity_reached')) {
      // try next car
      continue;
    }
    // unknown DB error
    return { ok: false, reason: 'DB_ERROR', detail: em };
  }
  return { ok: false, reason: 'NO_CAR_AVAILABLE' };
}

// ---------- webhook: POST /testdrive/book ----------
app.post('/testdrive/book', async (req, res) => {
  const {
    start_iso,
    duration_minutes,
    car_id,
    model,
    customer_name,
    customer_email,
    customer_phone,
    source = 'agent'
  } = req.body || {};

  try {
    // 0) Resolve business (text code -> uuid)
    const { bizUuid, bizCode } = await resolveBusiness(req.body);

    if (!start_iso) {
      return res.status(400).json({ ok: false, code: 'BAD_REQUEST',
        agent_say: 'I’m missing the time. Let me try that again.' });
    }

    // 1) Load settings (uuid-based)
    const { data: settings, error: settingsErr } = await supabase
      .from('business_settings')
      .select('timezone, slot_minutes, gcal_main_id, gcal_busy_id')
      .eq('business_id', bizUuid)
      .single();

    if (settingsErr || !settings) {
      return res.status(400).json({ ok:false, code:'CONFIG',
        agent_say:'Their system settings are missing. I’ll flag this and follow up.' });
    }

    const tz   = settings.timezone || 'America/Chicago';
    const slot = duration_minutes || settings.slot_minutes || 30;

    // 2) Normalize to business tz → UTC window
    const startLocal = DateTime.fromISO(start_iso, { setZone: true }).setZone(tz);
    if (!startLocal.isValid) {
      return res.status(400).json({ ok:false, code:'BAD_TIME',
        agent_say:'That time doesn’t look valid. Can we try another time?' });
    }
    const endLocal = startLocal.plus({ minutes: slot });
    const startUtc = startLocal.toUTC().toISO();
    const endUtc   = endLocal.toUTC().toISO();

    // 3) Busy calendar blocks everything
    if (settings.gcal_busy_id) {
      const busy = await gcalHasOverlap(settings.gcal_busy_id, startUtc, endUtc);
      if (busy) {
        return res.status(409).json({ ok:false, code:'BUSY_CAL',
          agent_say:`They’re unavailable around ${sayTimeLocal(start_iso, tz)}. I can check the next open slot.` });
      }
    }

    // Base payload for insert
    const payloadBase = {
      business_id: bizUuid,             // <-- uuid for appointments
      customer_name:  customer_name || null,
      customer_email: customer_email || null,
      customer_phone: customer_phone || null,
      starts_at: startUtc,
      ends_at:   endUtc,
      source
    };

    let apptId = null;
    let chosenCarId = car_id || null;

    // 4) Choose/insert
    if (chosenCarId) {
      // sanity check: car belongs to business & active
      const { data: okCar } = await supabase
        .from('cars')
        .select('id')
        .eq('id', chosenCarId)
        .eq('business_id', bizUuid)
        .eq('is_active', true)
        .maybeSingle();

      if (!okCar) {
        return res.status(400).json({ ok:false, code:'CAR_INVALID',
          agent_say:'That vehicle isn’t available. Let me pick another one for you.' });
      }

      const ins = await supabase
        .from('appointments')
        .insert([{ ...payloadBase, car_id: chosenCarId }])
        .select('id')
        .single();

      if (ins.error) {
        const em = String(ins.error.message || '');
        if (em.includes('ex_no_overlap_per_car')) {
          return res.status(409).json({ ok:false, code:'CAR_OVERLAP',
            agent_say:'That car was just booked at that time. Would you like the next slot?' });
        }
        if (em.includes('capacity_reached')) {
          return res.status(409).json({ ok:false, code:'CAPACITY_FULL',
            agent_say:'All test-drive slots are full at that time. I can check the next available time.' });
        }
        return res.status(500).json({ ok:false, code:'DB_ERROR', agent_say:'Something went wrong saving that.' });
      }

      apptId = ins.data.id;

    } else {
      if (!model) {
        return res.status(400).json({ ok:false, code:'NEED_CAR_OR_MODEL',
          agent_say:'Do you have a specific car in mind? I can also check by model.' });
      }

      const resTry = await tryInsertForAnyCarOfModel(bizUuid, model, startUtc, endUtc, payloadBase);
      if (!resTry.ok) {
        if (resTry.reason === 'NO_CAR_OF_MODEL') {
          return res.status(409).json({ ok:false, code:'NO_CAR_OF_MODEL',
            agent_say:`They don’t have an active ${model} right now. I can check another model.` });
        }
        if (resTry.reason === 'NO_CAR_AVAILABLE') {
          return res.status(409).json({ ok:false, code:'NO_CAR_AVAILABLE',
            agent_say:`No ${model} is free around ${sayTimeLocal(start_iso, tz)}. I can check 30 minutes later for you.` });
        }
        return res.status(500).json({ ok:false, code:'DB_ERROR', agent_say:'Something went wrong saving that.' });
      }
      apptId = resTry.apptId;
      chosenCarId = resTry.carId;
    }

    // 5) Create main calendar event (best effort)
    let eventId = null;
    if (settings.gcal_main_id) {
      try {
        const ev = await gcalCreateEvent(settings.gcal_main_id, {
          summary: `Test drive — ${customer_name || customer_phone || 'customer'}`,
          description: `Appointment ${apptId}`,
          start: startUtc,
          end: endUtc,
          timezone: tz
        });
        eventId = ev?.id || null;
        await supabase.from('appointments')
          .update({ gcal_event_id: eventId })
          .eq('id', apptId);
      } catch (_) {
        // keep booking; just skip calendar error
      }
    }

    // (Optional) If you log to public.stats, keep using the TEXT code there
    // await supabase.from('stats').insert([{ business_id: bizCode, call_type: 'book_test_drive', appointment_id: apptId }]);

    return res.status(200).json({
      ok: true,
      agent_say: `You’re all set for ${sayTimeLocal(start_iso, tz)}. See you then!`,
      data: {
        appointment_id: apptId,
        car_id: chosenCarId,
        gcal_event_id: eventId,
        starts_at_utc: startUtc,
        ends_at_utc: endUtc
      }
    });

  } catch (e) {
    const em = String(e.message || e);
    if (em === 'BUSINESS_MISSING') {
      return res.status(400).json({ ok:false, code:'BUSINESS_MISSING',
        agent_say:'I’m missing which dealership this is for. Let me try that again.' });
    }
    if (em === 'BUSINESS_NOT_FOUND') {
      return res.status(400).json({ ok:false, code:'BUSINESS_NOT_FOUND',
        agent_say:'I couldn’t find that dealership in the system.' });
    }
    console.error(e);
    return res.status(500).json({ ok:false, code:'UNKNOWN',
      agent_say:'I hit an unexpected issue. Let me try another time or follow up by text.' });
  }
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
  console.log("got inside book");
  
  const { name, email, phone, bookingTime, calendarId, blockingCalendarId, appointmentType, specialNotes } = data;
  const businessId = data.business_id;
  
  
  if (!name || !bookingTime || !calendarId) {
    return res.json({ status:'error', message:'Missing name, calendarId or bookingTime' });
  }

  const timezone    = data.timezone || DEFAULTS.timezone;
  console.log("timezone:", timezone);
  const officeStart = data.officeStart ?? DEFAULTS.officeStart;
  const officeEnd   = data.officeEnd ?? DEFAULTS.officeEnd;
  let durationMin = parseInt(data.durationMin) || DEFAULTS.durationMin;
  if (!durationMin || durationMin <= 0 || data.durationMin === "<duration>") {
    durationMin = DEFAULTS.durationMin;
  }
  console.log("duration", durationMin) 
  const maxOverlaps = (data.maxOverlaps || DEFAULTS.maxOverlaps);
  
  const blockingId = blockingCalendarId || calendarId;

  const startLux = DateTime.fromISO(bookingTime, { zone: timezone });
  const endLux   = startLux.plus({ minutes: durationMin });
  const now = DateTime.now().setZone(timezone);
  const diffMinutes = startLux.diff(now, 'minutes').minutes;
  console.log("extracted inputs", name, email, phone, bookingTime, calendarId, blockingCalendarId, appointmentType, specialNotes, durationMin, startLux, endLux);
  if (diffMinutes < 30) {
    await supabase.from('stats').insert([{
      business_id: data.business_id,
      call_type: 'rejected',
      phone: data.phone,
      metadata: {
        name: data.name,
        email: data.email,
        reason: "too_soon"
      }
    }]);
    return res.json({ status: 'rejected', reason: 'too_soon' });
  }
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
  console.log("freebusy query complete");

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
  console.log("after block check");
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
  }
  console.log("after calendar chack");

  const event = {
    summary: `Appointment with (${name})`,
    description: `Email: ${email || 'N/A'}\nPhone: ${phone || 'N/A'}${specialNotes ? `\nNotes: ${specialNotes}` : ''}`,
    start:       { dateTime: start.toISOString() },
    end:         { dateTime: end.toISOString() },
    location:    `Phone: ${phone || ''}`
  };
  console.log("event created");
  const inserted = await calendar.events.insert({
    calendarId,
    resource: event
  });
  console.log("moving onto booking");
  await supabase.from('stats').insert([{
    business_id: businessId,
    call_type: 'booking',
    phone: data.phone,
    appointment_id: inserted.data.id,
    metadata: {
      name: data.name,
      email: data.email,
      phone: data.phone,
      timezone: timezone,
      start: start.toISOString(),
      end: end.toISOString(),
      appointment_type: appointmentType || "default"
    } 
  }]);
  console.log("finished stats insert");

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




// Modified CANCEL function using Supabase to identify the appointment
async function cancel(data, res) {
  const { name, email, phone, calendarId, business_id } = data;

  if (!name || (!email && !phone) || !calendarId || !business_id) {
    return res.json({ status: 'error', message: 'Missing required fields' });
  }

  const nowISO = DateTime.now().toISO();

  const { data: matchingStats, error } = await supabase
    .from('stats')
    .select('appointment_id, metadata')
    .eq('business_id', business_id)
    .eq('call_type', 'booking')
    .gte('metadata->>start', nowISO)
    .order('metadata->>start', { ascending: true })
    .limit(10);

  if (error || !matchingStats || matchingStats.length === 0) {
    return res.json({ status: 'not_found', message: 'No recent appointments found' });
  }

  // Find all entries that match name + (email or phone)
  const possibleMatches = matchingStats.filter(entry => {
    const meta = entry.metadata || {};
    const nameMatch = (meta.name || '').toLowerCase() === name.toLowerCase();

    const emailMatch = email && meta.email
      ? meta.email.toLowerCase() === email.toLowerCase()
      : false;

    const phoneMatch = phone && meta.phone
      ? String(meta.phone) === String(phone)
      : false;

    return nameMatch && (emailMatch || phoneMatch);
  });

  if (possibleMatches.length === 0) {
    return res.json({ status: 'not_found', message: 'No matching appointment' });
  }

  // Find the first one that’s still deletable
  for (const match of possibleMatches) {
    try {
      const startTimeISO = match.metadata?.start || null;
      if (startTimeISO) {
        const eventStart = DateTime.fromISO(startTimeISO);
        const now = DateTime.now();
        const minutesAway = eventStart.diff(now, 'minutes').minutes;

        if (minutesAway < 60) {
          continue; // Too close to cancel
        }
      }

      // Attempt to delete from calendar
      await calendar.events.delete({
        calendarId,
        eventId: match.appointment_id
      });

      // Delete from Supabase
      await supabase
        .from('stats')
        .delete()
        .eq('appointment_id', match.appointment_id);

      return res.json({
        status: 'success',
        results: {
          status: 'cancelled',
          data: { appointment_id: match.appointment_id }
        }
      });

    } catch (err) {
      if (err.code === 410) {
        // Event already deleted – remove from Supabase too
        await supabase
          .from('stats')
          .delete()
          .eq('appointment_id', match.appointment_id);

        return res.json({
          status: 'already_deleted',
          results: {
            status: 'gone',
            message: 'The appointment was already deleted'
          }
        });
      }

      console.error('Failed to delete calendar event:', err);
      return res.json({ status: 'error', message: 'Failed to cancel appointment' });
    }
  }

  // If loop finished without returning, all matches were too close to cancel
  return res.json({ status: 'rejected', reason: 'too_close_to_cancel' });
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
