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
// GET /inventory/models?business_id=...&activeOnly=true
// Returns unique model names (e.g., ["Audi R8","Audi A8","Q5"])
app.get("/inventory/models", async (req, res) => {
  try {
    const business_id = req.query.business_id;
    const activeOnly  = (req.query.activeOnly ?? "true").toString().toLowerCase() === "true";

    if (!business_id) {
      return res.status(400).json({ ok: false, error: "Missing business_id" });
    }

    let q = supabase.from("cars").select("model").eq("business_id", business_id);
    if (activeOnly) q = q.eq("is_active", true);

    const { data, error } = await q;
    if (error) return res.status(500).json({ ok: false, error: error.message });

    const models = [...new Set((data || []).map(r => r.model).filter(Boolean))].sort((a,b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" })
    );

    return res.json({ ok: true, business_id, activeOnly, count: models.length, models });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// (Optional) GET /inventory/cars?business_id=...&activeOnly=true
// Returns individual units if you want finer control later.
app.get("/inventory/cars", async (req, res) => {
  try {
    const business_id = req.query.business_id;
    const activeOnly  = (req.query.activeOnly ?? "true").toString().toLowerCase() === "true";
    if (!business_id) {
      return res.status(400).json({ ok: false, error: "Missing business_id" });
    }

    let q = supabase
      .from("cars")
      .select("id, model, trim, vin, is_active")
      .eq("business_id", business_id);

    if (activeOnly) q = q.eq("is_active", true);

    const { data, error } = await q;
    if (error) return res.status(500).json({ ok: false, error: error.message });

    return res.json({ ok: true, business_id, activeOnly, cars: data || [] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
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
/// ===============================
// POST /testdrive
// ===============================
// /testdrive — book a test drive without storing officeStart/End in DB
app.post("/testdrive", async (req, res) => {
  const data = req.body;

  try {
    const {
      name, email, phone,
      bookingTime, calendarId, blockingCalendarId,
      specialNotes, model
    } = data;

    // REQUIRED inputs
    const businessId  = data.business_id; // TEXT (your human code, e.g. '123abc')
    if (!name || !bookingTime || !calendarId || !businessId) {
      return res.status(400).json({ status: "error", message: "missing_fields" });
    }

    // Config / Defaults
    const DEFAULTS = {
      timezone: "America/Chicago",
      officeStart: 7.5,          // 7:30
      officeEnd: 20,             // 20:00
      testDriveDurationMin: 30,
      maxOverlaps: 3             // advisory for GCal only
    };
    const timezone    = data.timezone || DEFAULTS.timezone;
    const officeStart = data.officeStart ?? DEFAULTS.officeStart;
    const officeEnd   = data.officeEnd   ?? DEFAULTS.officeEnd;
    const maxOverlaps = data.maxOverlaps ?? DEFAULTS.maxOverlaps;
    const DURATION_MIN = DEFAULTS.testDriveDurationMin;

    // Time handling (Luxon)
    const startLux = DateTime.fromISO(bookingTime, { zone: timezone });
    if (!startLux.isValid) {
      return res.status(400).json({ status: "error", message: "invalid_booking_time" });
    }
    const endLux   = startLux.plus({ minutes: DURATION_MIN });
    const nowLux   = DateTime.now().setZone(timezone);

    // Too soon (<30 min)
    const diffMinutes = startLux.diff(nowLux, "minutes").minutes;
    if (diffMinutes < 30) {
      return res.status(409).json({ status: "rejected", reason: "too_soon" });
    }

    // Office hours validation (advisory)
    const h0 = startLux.hour + startLux.minute / 60;
    const h1 = endLux.hour   + endLux.minute / 60;
    const officeStartFloat = parseFloat(String(officeStart));
    const officeEndFloat   = parseFloat(String(officeEnd));
    if (h0 < officeStartFloat || h1 > officeEndFloat) {
      return res.status(409).json({ status: "rejected", reason: "outside_office_hours" });
    }

    // Canonical UTC for DB + GCal
    const start = new Date(startLux.toUTC().toISO());
    const end   = new Date(endLux.toUTC().toISO());

    // GCal freebusy (advisory)
    const blockingId = blockingCalendarId || calendarId;
    const fb = await calendar.freebusy.query({
      requestBody: {
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        items: [{ id: calendarId }, { id: blockingId }]
      }
    }).then(r => r.data);

    const busyBlock = fb.calendars?.[blockingId]?.busy || [];
    if (busyBlock.length > 0) {
      return res.status(409).json({ status: "rejected", reason: "slot_blocked" });
    }

    const busyMain = fb.calendars?.[calendarId]?.busy || [];
    const maxOverlapsNum = parseInt(maxOverlaps, 10) || DEFAULTS.maxOverlaps;
    if (busyMain.length >= maxOverlapsNum) {
      return res.status(409).json({ status: "rejected", reason: "slot_full" });
    }

    // Choose/allocate unit
    // A) current method: RPC picks a free car (non-atomic, but DB exclusion guard protects final insert)
    //    If your RPC returns a TEXT car_id (uuid as string), keep as-is.
    let chosenCarId = null;
    if (!model) {
      // If you want to require a model for test drives, enforce here:
      // return res.status(400).json({ status:"error", message:"model_required_for_testdrive" });
    } else {
      const { data: rpcData, error: rpcErr } = await supabase.rpc("pick_free_car", {
        p_business_id: businessId,
        p_model: model,
        p_start: start.toISOString(),
        p_end:   end.toISOString()
      });
      if (rpcErr) {
        console.error("pick_free_car RPC error:", rpcErr);
        return res.status(500).json({ status: "error", message: "car_allocation_failed" });
      }
      if (!rpcData) {
        return res.status(409).json({ status: "rejected", reason: "no_unit_available" });
      }
      chosenCarId = rpcData; // text uuid or whatever your RPC returns
    }

    // Idempotency key (prevents duplicate rows on retries)
    const idem = [
      businessId,
      'testdrive',
      start.toISOString(),
      (name || '').trim().toLowerCase()
    ].join('|');

    // Insert appointment first (DB = source of truth)
    const insertPayload = {
      idem_key: idem,
      business_id: businessId,               // TEXT
      name,
      email: email?.trim()?.toLowerCase() || null,
      phone: phone || null,
      model: model || null,
      car_unit_id: chosenCarId || null,      // TEXT
      calendar_id: calendarId,
      blocking_calendar_id: blockingId,
      timezone,
      booking_time_local: startLux.toISO(),
      starts_at: start.toISOString(),
      ends_at: end.toISOString(),
      call_type: "testdrive",
      status: "booked",
      source: "agent",
      special_notes: specialNotes || null,
      gcal_event_id: null
    };

    // Upsert on idem_key so retries don't double-book
    const ins = await supabase
      .from("appointments")
      .upsert([insertPayload], { onConflict: 'idem_key' })
      .select("id, car_unit_id, starts_at, ends_at")
      .single();

    if (ins.error) {
      // If this is an overlap, Postgres throws 23P01; Supabase surfaces it as error with code
      if (ins.error.code === '23P01') {
        return res.status(409).json({ status: "rejected", reason: "overlap" });
      }
      console.error("appointments upsert failed:", ins.error);
      return res.status(500).json({ status: "error", message: "db_upsert_failed" });
    }

    const apptId = ins.data.id;

    // Create GCal event AFTER DB insert
    const event = {
      summary: `Test Drive (${name})${model ? ` — ${model}` : ""}`,
      description: [
        `Email: ${email || "N/A"}`,
        `Phone: ${phone || "N/A"}`,
        model ? `Model: ${model}` : null,
        chosenCarId ? `Unit: ${chosenCarId}` : null,
        specialNotes ? `Notes: ${specialNotes}` : null
      ].filter(Boolean).join("\n"),
      start: { dateTime: start.toISOString() },
      end:   { dateTime: end.toISOString() }
    };

    let insertedEvent;
    try {
      insertedEvent = await calendar.events.insert({ calendarId, requestBody: event });
    } catch (calErr) {
      console.error("calendar insert failed, rolling back appointment:", calErr);
      // Best-effort rollback (keeps calendars and DB consistent)
      await supabase.from("appointments").delete().eq("id", apptId);
      return res.status(502).json({ status: "error", message: "calendar_insert_failed" });
    }

    const gcalId = insertedEvent?.data?.id || null;
    if (gcalId) {
      await supabase.from("appointments")
        .update({ gcal_event_id: gcalId })
        .eq("id", apptId);
    }

    // TODO: fire SMS confirmation here (post-commit), best-effort

    return res.status(201).json({
      status: "success",
      results: {
        status: "booked",
        data: {
          appointmentId: apptId,
          eventId: gcalId,
          start: toLocalISOString(start, timezone),
          end:   toLocalISOString(end, timezone)
        }
      }
    });

  } catch (e) {
    // If Postgres exclusion hit here, it will have code 23P01
    if (e && e.code === '23P01') {
      return res.status(409).json({ status: "rejected", reason: "overlap" });
    }
    console.error("testdrive unexpected error", e);
    return res.status(500).json({ status: "error", message: "server_error" });
  }
});

// Minimal helper if you don't already have it
function toLocalISOString(dateObj, tz = "America/Chicago") {
  const { DateTime } = require('luxon');
  return DateTime.fromJSDate(dateObj, { zone: 'utc' }).setZone(tz).toISO();
}


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
