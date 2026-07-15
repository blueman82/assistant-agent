import { zonedMinutesOfDay } from "./proactive/push.ts";

// Check: exactly 00:00 Dublin summer
const at0000summer = new Date("2026-07-15T23:00:00Z"); // 00:00 IST (summer)
console.log("00:00 Dublin summer:", zonedMinutesOfDay(at0000summer, "Europe/Dublin"));

// Check: exactly 00:00 Dublin winter
const at0000winter = new Date("2026-01-15T00:00:00Z"); // 00:00 GMT (winter)
console.log("00:00 Dublin winter:", zonedMinutesOfDay(at0000winter, "Europe/Dublin"));

// Sanity check: known working point from test
const daytime = new Date("2026-07-15T07:30:00Z");
console.log("08:30 Dublin summer (expect 510):", zonedMinutesOfDay(daytime, "Europe/Dublin"));
