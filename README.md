# Fuel Tank Warner

Watches every vehicle on the GPS server (fms.gpsbox.mn) and warns you when fuel disappears,
when a tracker is tampered with, and about other changes (idling, speeding, trackers going
silent). Everything runs on this computer; nothing needs to be installed except Node.js.

## Start it

1. Install **Node.js 22.13 or newer** (LTS) from https://nodejs.org if it is not installed.
2. Double-click **`start.bat`**. A black window opens and, after a moment, the dashboard opens
   in your browser at **http://127.0.0.1:8080**.
3. Keep the black window open (you can minimise it). Closing it, or pressing Ctrl+C in it,
   stops the warner.

On the first start it downloads the last 7 days of history for every vehicle (a few
minutes). Alerts found in that history are marked "History" and do not pop up; only new
events trigger notifications.

### Start automatically when Windows starts

1. Right-click `start.bat` → **Show more options** → **Create shortcut**.
2. Press **Win + R**, type `shell:startup`, press Enter. A folder opens.
3. Move the shortcut into that folder. (Optional: right-click the shortcut → Properties →
   Run: **Minimized**.)

## The dashboard

- **Fleet** – every vehicle with its status (moving / idle / parked / offline), fuel level and
  open alerts. Click a vehicle for its fuel chart, route and alert history.
- **Map** – where every vehicle is now.
- **Alerts** – everything that was detected, newest first. Acknowledge alerts once you have
  looked at them.
- **Report** – distance, engine hours and fuel used per vehicle for a period, and the Excel
  fuel ledger (below).
- **Settings** – alert thresholds, notifications, tank calibration, muting vehicles.

## Excel fuel ledger

Every refuel and every suspected fuel theft (fuel drain) is saved automatically to
**`Fuel events.xlsx`** in this folder – a permanent record you can open, filter and share.

- It is rewritten from the database about 30 seconds after a refuel or theft is found or
  changes, once after the history has loaded at start-up, and checked every hour. Refuels and
  fuel drains are never deleted from the database, so the file keeps the whole history.
- Sheets: **Thefts** and **Refuels** (newest first: start time and detection time, vehicle,
  litres, level before and after, where it happened, map link, your verdict and note),
  **By vehicle** and **By day** (totals), and **About** (what every column means). Times are
  Ulaanbaatar time and real Excel dates, so sorting and filtering work. Litres come from the GPS
  server's tank tables; vehicles without one show mV only.
- On a fuel-drain alert (Alerts view or a vehicle's page) mark it **Confirmed theft** or
  **False alarm**, and type a **note** on any refuel or theft (saved when you press Enter or
  leave the box). They are saved in the file. False alarms and drains whose level came back are
  listed but not counted in the totals (a drain whose level came back does count if you mark it
  Confirmed theft). The Report's "Suspected fuel loss" counts the same way.
- **Report → Download Excel** gives you the same workbook right away; **Open folder** shows the
  file in Explorer.
- If the file is open in Excel when it has to be updated, nothing is lost: the dashboard shows
  "Excel file is open — it will be updated when you close it" and the program tries again every
  minute. The file is replaced each time, so don't type into it – save a copy under another name
  if you want to edit it. (If the file is marked read-only in its Properties, the dashboard says
  so; untick "Read-only".) Your verdicts and notes reach the file even while the GPS server is
  not answering.
- Another file name or folder: set `"excelFile"` in `config.json` (or the `EXCEL_FILE`
  environment variable); `""` turns the automatic file off (the download still works).

## Tank calibration (litres)

The fuel sensor reports a voltage (mV), not litres. The tank tables set up on the GPS
server (sensor "Fuel tank") are included in `calibrations.json`, so trucks listed there show
litres automatically. For any other truck, 0 mV = empty and 10 000 mV = full, and amounts are
shown in mV and % of the tank. To set or correct a truck, open Settings → calibration (or the
vehicle's page) and enter:

- **Empty mV** – the reading with an (almost) empty tank,
- **Full mV** – the reading with a full tank (look at the level right after a full refuel),
- **Tank size** in litres.

What you enter replaces the GPS-server table for that truck (saving the form unchanged keeps the
table). The vehicle's page has a **Use the default calibration** link to go back to the table.

## Notifications

- **Windows notifications** pop up for critical alerts and warnings (on by default). Clicking
  one opens the dashboard. A vehicle + alert type pops up at most once every 10 minutes, and
  several alerts at once are combined into one message. While these are on, the browser does
  not pop up the same alerts again (the dashboard still shows them on the page).
- **Telegram** (optional, reaches your phone):
  1. In Telegram, talk to **@BotFather**, send `/newbot`, follow the steps and copy the
     **bot token** (looks like `123456789:AAH...`).
  2. Open your new bot and press **Start** (or add the bot to a group).
  3. Find your **chat id**: talk to **@userinfobot** (for a group, the id starts with `-100`).
  4. Enter both in Settings → Notifications and press **Send test**.
- **Mute** a vehicle (for example while it is in the workshop) to stop its pop-ups. Its alerts
  are still recorded.

## What each alert means

| Alert | Level | Meaning |
|---|---|---|
| Fuel drain | critical | Fuel went down while the vehicle was parked (also across switching the master switch off and on), at a short stop (judged from the level while driving in and out, only when two driving estimates or the next parked reading agree), or much more fuel was used between two stops than the engine time and distance explain. Possible theft or leak. If a parked drop later comes back (a sensor or tilt artefact), the alert is downgraded to *info* "Fuel sensor dip (level recovered)"; a slow loss over hours stays one alert whose amount grows. |
| Tracker power cut | critical | The tracker lost vehicle power while driving - someone may have disconnected it. |
| Fuel sensor fault | warning | The fuel sensor reads ~0 (or is stuck) while the vehicle has power: cut wire, unplugged or faulty sensor. A probe held at its top by a full tank is not a fault. |
| Low fuel | warning | Tank below the low-fuel limit (default 10 %), or "Tank nearly empty" when the reading slides below the sensor's range from an already low level. |
| Long idle | warning | Engine running without moving for longer than the limit (default 30 min). |
| Overspeed | warning | Faster than the limit (default 90 km/h). |
| Offline | warning | A tracker that was reporting has gone silent (no mobile coverage, unplugged, or powered off). Parked trackers normally report only once an hour, so they get extra time. Vehicles that went silent while the program was not running are recorded as "History" (no pop-up). An outage that ended while the program was stopped is closed at the first report after it. |
| GPS server event | warning | An event from the GPS server's own alert rules, passed through. |
| After-hours movement | warning | Moving during the night hours (off by default; set the hours in Settings). |
| Refuel | info | The tank was filled. |
| Fuel sensor restored / Power restored / Back online | info | The earlier problem has ended. |

Why the numbers can be trusted: while driving the fuel reading sloshes by thousands of mV,
so the fuel level is only measured from steady readings while a vehicle stands still. Short
waits (e.g. traffic) do not produce alerts. Trackers parked in hourly reporting mode need
three agreeing readings over two hours before a change counts.

Gaps in the data: when a tracker loses mobile coverage while driving, it uploads the missed
records later. The program then waits (20 minutes to 2 hours) until that backlog has arrived
before judging the time after the gap, and fetches rows that reach the GPS server late. When
data is missing for more than 2 hours and the vehicle may have moved, no fuel loss is judged
across that hole (a refuel still shows). History older than the backfill window (7 days, e.g.
after the computer was off for longer) is never fetched; what comes after such a hole is stored
as "History".

## Report figures

- **Distance** – from the tracker's odometer (GPS distance if a tracker has none).
- **Engine hours** – time the engine was running while the tracker was reporting: driving, or
  standing with the ignition on *and* the alternator charging (many trackers report the
  ignition as on all the time, so the ignition alone would overstate it).
- **Fuel used** – worked out from the steady (parked) fuel levels: every fall of the level of
  more than 50 mV, plus the fuel burnt on the way to a refuel (level before + refuel − level
  after), minus amounts flagged as fuel drains. While a vehicle stands still only the net change
  counts, so a parked level wandering up and down is not "used". It is only as complete as the
  parked readings: "≥ 34 L" means the steady readings cover only part of the distance (hover to
  see how much; such vehicles are left out of the total), and "—" means the sensor is faulty or
  there were not enough steady readings. Refuels and drains are totals of those alerts, counted
  as in the Excel fuel ledger (drains you marked False alarm, and drains whose level came back,
  are left out); the table sorts them by the litres shown.

## Settings file and advanced options

`config.json` holds the GPS server address and API key and the default thresholds. Changes
made in the dashboard are stored in the database and take priority over `config.json`. The
fuel thresholds are in mV (the sensor's unit); Settings shows what each value means in litres
for your tank types. Each truck's consumption learned from its own trips is kept in the
database too, so a restart judges trips the same way.

Environment variables (for special setups):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 8080 | Web port of the dashboard |
| `HOST` | 127.0.0.1 | Set to `0.0.0.0` to open the dashboard from other computers on the network (there is no password - only do this on a trusted network) |
| `DATA_DIR` | `data` folder here | Where the database (`fuel.db`) and log (`app.log`) are kept |
| `CONFIG` | `config.json` here | Use a different settings file |
| `NO_BACKFILL` | – | `1` = do not download history at start (for quick tests) |
| `EXCEL_FILE` | `Fuel events.xlsx` here | Where the Excel fuel ledger is written |

History is kept for 7 days (`keepHours`), fuel levels and alerts for 90 days (`keepDays`),
refuels and fuel drains forever (they are the Excel fuel ledger). At start-up up to 7 days of
missing history is downloaded (`backfillHours`). To start from scratch, stop the program and
delete the `data` folder.

## Troubleshooting

- **"Port 8080 is already in use"** – the warner is already running; just open
  http://127.0.0.1:8080.
- **Red banner "The GPS server is not answering"** – internet or GPS server problem. The
  program keeps retrying and catches up automatically when the connection is back.
- **"The GPS server's call limit is reached"** – the API key has made too many requests (for
  example several copies of the program running with the same key). The program stops asking
  for 10 minutes (longer if it happens again, at most an hour) and then catches up by itself.
- Details of what happened are in `data/app.log`.
