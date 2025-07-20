const fs = require('fs');
const { google } = require('googleapis');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const DURATION_MAP = {
  consultation: 30,
  followup: 15,
  intake: 60
};
const app = express();
app.use(cors());
app.use(bodyParser.json());

const KEYFILEPATH = 'D:/Downloads/upreach-backend-466407-e5d817328099.json';
const SCOPES = ['https://www.googleapis.com/auth/calendar'];

const auth = new google.auth.GoogleAuth({
  keyFile: KEYFILEPATH,
  scopes: SCOPES,
});

const calendar = google.calendar({ version: 'v3', auth });

app.post('/book-appointment', async (req, res) => {
  console.log('Request body:', req.body);
  const { name, email, phone, startTime } = req.body;

  if (!name || !email || !startTime) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Default duration: 1 hour
  const start = new Date(startTime);
  const end = new Date(start.getTime() + 60 * 60 * 1000); // 1 hour later

  try {
    const event = {
      summary: `Appointment: ${name} (${email})`,
      description: `Booked by: ${name}\nEmail: ${email}\nPhone: ${phone}`,
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
      location: `Phone: ${phone}`,
    };

    const response = await calendar.events.insert({
      calendarId: '289e6c18f91f6e06f9710f6ed825f9e9aeb1585c56bdf5448a95a2717f865310@group.calendar.google.com',
      resource: event,
    });

    res.status(200).json({ message: 'Appointment booked', eventId: response.data.id });
 } catch (error) {
  console.error('Google API Error:', error.response?.data || error.message || error);
  res.status(500).json({ error: 'Internal Server Error' });
}
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});
