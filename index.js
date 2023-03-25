const express = require("express");
const morgan = require("morgan");
const ical = require("ical-generator");
const axios = require("axios");
const dotenv = require("dotenv");
const path = require("path");
dotenv.config();

let cachedStates = null;
let cachedEvents = null;

const app = express();
app.set('case sensitive routing', false);
app.use(express.static(path.join(__dirname, 'public')));

morgan.token('statusColor', (req, res, args) => {
  var status = (typeof res.headersSent !== 'boolean' ? Boolean(res.header) : res.headersSent)
      ? res.statusCode
      : undefined

  // get status color
  var color = status >= 500 ? 31 // red
      : status >= 400 ? 33 // yellow
      : status >= 300 ? 36 // cyan
      : status >= 200 ? 32 // green
      : 0; // no color

  return '\x1b[' + color + 'm' + status + '\x1b[0m';
});
app.use(morgan(':statusColor :method :url - :response-time ms - :remote-addr :remote-user'));

// State RCJ title mapping information, will fall back to "RCJA" if no mapping is found
const stateTitleMapping = {
  "VIC": "RCJV",
  "NSW": "RCJNSW",
  "QLD": "RCJQ",
  "SA": "RCJSA",
  "WA": "RCJWA",
  "NT": "RCJNT",
  "ACT": "RCJACT",
  "TAS": "RCJTAS",
  "NAT": "RCJA"
}
// Background task to fetch events from the RCJA Entry System API and store them in a local cache
// This is to avoid having to make a request to the API every time a user requests a calendar file
const fetchEvents = async () => {
  try {
    const { data: states } = await axios.get(
      "https://enter.robocupjunior.org.au/api/v1/public/states/"
    );
    
    let stateCodes = states.map(state => state.abbreviation);
    let events = {};
    stateCodes.forEach(key => events[key] = []);
    
    for (const state of states) {
      const { data: stateEvents } = await axios.get(
        `https://enter.robocupjunior.org.au/api/v1/public/states/${state.abbreviation}/upcomingEvents/`
      );
      events[state.abbreviation] = stateEvents;
    }
    
    cachedStates = states;
    cachedEvents = events;
  } catch (error) {
    console.error(`Error fetching events: ${error}`);
  }
};

setInterval(fetchEvents, process.env.FETCH_INTERVAL || 3600000); // 1 hour
fetchEvents();

// Query Parameters:
// - regions: The regions abbreviation(s) to filter by (e.g. "VIC" or "VIC,NSW")
// - hide: The event type(s) to hide (e.g. "competitions" or "workshops", cannot be both)
app.get("/file", async (req, res) => {
  if (!cachedEvents) {
    res.status(503).send({ error: "Events cache is not yet populated, please try again shortly." });
    return;
  }
  try {
    let events = [];
    
    let stateCodes = Object.keys(cachedEvents);
    let requestedStateCodes = req.query.regions ? req.query.regions.split(",") : stateCodes;

    // make sure all requestedStateCodes match stateCodes
    if (requestedStateCodes.some(state => !stateCodes.includes(state))) {
      res.status(400).send({ error: "Invalid state code(s) provided." });
      return;
    }

    requestedStateCodes.forEach(state => {
      if (req.query.hide !== "competitions") events = events.concat(cachedEvents[state].filter(event => event.eventType === "competition"));
      if (req.query.hide !== "workshops") events = events.concat(cachedEvents[state].filter(event => event.eventType === "workshop"));
    });

    const calendar = ical({
      domain: "rcja.app/calendar",
      name: `RoboCup Junior Australia: Calendar`,
      timezone: "Australia/Melbourne",
    });
    
    events.forEach((event) => {
      const eventDescription = `${event.name} (${cachedStates.find(state => state.id === event.state).name})`
                        + `\n\nEvent type: ${event.eventType.toLowerCase().replace(/(^|\s)\S/g, L => L.toUpperCase())}`
                        + `\n\nStart date: ${event.startDate}`
                        + `\nEnd date: ${event.endDate}`
                        + `\nRegistrations open: ${event.registrationsOpenDate}`
                        + `\nRegistrations close: ${event.registrationsCloseDate}`
                        + `\n\nDirect enquiries to: ${event.directEnquiriesTo.fullName} (${event.directEnquiriesTo.email})`
                        + `\nAvailable divisions: ${event.availabledivisions.map(division => division.name).join(", ")}`
                        + `\n\n${event.bleachedEventDetails}`
                        + `\n\n\n${event.registrationURL}`;

      const currentState = cachedStates.find(state => state.id === event.state);
      
      calendar.createEvent({
        start: new Date(event.startDate),
        end: new Date(new Date(event.endDate).setDate(new Date(event.endDate).getDate() + 1)),
        summary: `${stateTitleMapping[currentState.abbreviation] || "RCJA"} ${event.name} (${currentState.abbreviation})`, 
        description: eventDescription,
        allDay: true,
        location: event.venue ? event.venue.name + ", " + event.venue.address : "",
        url: `https://enter.robocupjunior.org.au/events/${event.id}`,
      });
    });

    res.set("Content-Type", "text/calendar");
    res.set("Content-Disposition", 'attachment; filename="calendar.ics"');
    res.send(calendar.toString());
  } catch (error) {
    console.error(error);
    res.status(500).send({ error: error.message });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public/calendar.html"));
});

app.listen(process.env.HTTP_PORT, () => {
  console.log(`Calendar server listening on port ${process.env.HTTP_PORT}`);
});