/**
 * Simulated TikTok "When to post" form used to validate the schedule-control
 * logic without a real login. It mirrors the real DOM seen in the user's
 * schedule-debug.log: read-only TUX text inputs, a hidden timepicker that is
 * always mounted, a fake "location" panel full of numbers, and a real calendar.
 *
 * Run with a local browser (Playwright or system Chrome). Without a browser it
 * still writes the fixture so the DOM can be inspected manually.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const FORM_HTML = `<!DOCTYPE html><html><head><style>
  body { margin: 0; font-family: sans-serif; }
  #sec { padding: 24px; }
  #pickers { margin-top: 16px; }
  input.TUXTextInputCore-input { display: inline-block; width: 160px; height: 36px; margin-right: 24px; }
  .calendar-panel { position: absolute; top: 120px; left: 320px; width: 320px; height: 300px; background: #fff; border: 1px solid #ccc; padding: 8px; }
  #calGrid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }
  #tp { position: absolute; top: 120px; left: 80px; width: 220px; height: 260px; background: #fff; border: 1px solid #ccc; overflow: auto; }
  .tiktok-timepicker-left, .tiktok-timepicker-right { display: inline-block; vertical-align: top; width: 90px; max-height: 240px; overflow: auto; }
  .tiktok-timepicker-option-text { padding: 6px 10px; cursor: pointer; }
  #locPanel { position: absolute; top: 560px; left: 0; width: 300px; height: 300px; }
</style></head><body>
<div id="sec">
  <div id="when"><span>When to post</span>
    <input type="radio" name="postSchedule" value="now" aria-checked="true" checked>
    <input type="radio" name="postSchedule" value="schedule" aria-checked="false">
  </div>
  <div id="pickers">
    <input id="time" class="TUXTextInputCore-input" value="21:10" readonly>
    <input id="date" class="TUXTextInputCore-input" value="2026-09-12" readonly>
  </div>
</div>

<!-- Real calendar, hidden until the date field is clicked. -->
<div id="cal" class="calendar-panel" style="display:none">
  <header><button aria-label="previous month">&lt;</button>
    <span id="calTitle">September 2026</span>
    <button aria-label="next month">&gt;</button></header>
  <div id="calGrid"></div>
</div>

<!-- A decoy panel with many numbers, like TikTok's location search. -->
<div id="locPanel" style="position:absolute; top:600px; left:0; width:300px; height:300px">
  <span>Location</span>
  <span>Search locations</span>
  ${Array.from({ length: 31 }, (_, i) => `<div>${i + 1}</div>`).join("")}
</div>

<!-- The real timepicker: always mounted; hidden via class until opened. -->
<div id="tp" class="tiktok-timepicker-time-picker-container tiktok-timepicker-invisible">
  <div class="tiktok-timepicker-left" id="hours"></div>
  <div class="tiktok-timepicker-right" id="minutes"></div>
</div>

<button data-e2e="post_video_button" id="submit">Schedule</button>
<script>
  const state = { time: "21:10", date: "2026-09-12", dateMonth: 8, dateYear: 2026 };

  // Radios: click the input, no label wrapper (like the real page).
  document.querySelector('input[value="schedule"]').addEventListener('change', () => {
    document.getElementById('pickers').style.display = 'block';
  });

  // Timepicker columns. TikTok marks the current value with is-active and
  // keeps the panel hidden with tiktok-timepicker-invisible until opened.
  const hours = document.getElementById('hours');
  for (let h = 0; h < 24; h++) {
    const d = document.createElement('div');
    d.className = 'tiktok-timepicker-option-item';
    const s = document.createElement('span');
    s.className = 'tiktok-timepicker-option-text tiktok-timepicker-left';
    s.textContent = String(h).padStart(2, '0');
    if (h === 21) s.classList.add('tiktok-timepicker-is-active');
    s.addEventListener('click', () => {
      const [, m] = state.time.split(':');
      state.time = s.textContent + ':' + m;
      commitTime();
    });
    d.appendChild(s); hours.appendChild(d);
  }
  const minutes = document.getElementById('minutes');
  for (let m = 0; m < 60; m += 5) {
    const d = document.createElement('div');
    d.className = 'tiktok-timepicker-option-item';
    const s = document.createElement('span');
    s.className = 'tiktok-timepicker-option-text tiktok-timepicker-right';
    s.textContent = String(m).padStart(2, '0');
    if (m === 10) s.classList.add('tiktok-timepicker-is-active');
    s.addEventListener('click', () => {
      const [h] = state.time.split(':');
      state.time = h + ':' + s.textContent;
      commitTime();
    });
    d.appendChild(s); minutes.appendChild(d);
  }
  function commitTime() { if (document.getElementById('tp').classList.contains('tiktok-timepicker-invisible')) return; setTimeValue(state.time); }

  // TikTok's input is read-only: only the picker may change its value. Reject any
  // direct programmatic write so the test cannot cheat through the native setter.
  const timeInput = document.getElementById('time');
  const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  let allowWrite = false;
  Object.defineProperty(timeInput, 'value', {
    get() { return nativeValue.get.call(this); },
    set(v) { if (allowWrite) nativeValue.set.call(this, v); },
    configurable: true,
  });
  function setTimeValue(v) { allowWrite = true; nativeValue.set.call(timeInput, v); allowWrite = false; }
  // Also reject keyboard typing (read-only inputs ignore it anyway).
  timeInput.addEventListener('beforeinput', (e) => e.preventDefault());

  function openTime() {
    const tp = document.getElementById('tp');
    tp.classList.remove('tiktok-timepicker-invisible');
  }
  function closeTime() {
    document.getElementById('tp').classList.add('tiktok-timepicker-invisible');
  }
  document.getElementById('time').addEventListener('click', openTime);

  // Calendar.
  const dateInput = document.getElementById('date');
  let allowDateWrite = false;
  Object.defineProperty(dateInput, 'value', {
    get() { return nativeValue.get.call(this); },
    set(v) { if (allowDateWrite) nativeValue.set.call(this, v); },
    configurable: true,
  });
  function setDateValue(v) { allowDateWrite = true; nativeValue.set.call(dateInput, v); allowDateWrite = false; }
  dateInput.addEventListener('beforeinput', (e) => e.preventDefault());

  function renderCal() {
    const grid = document.getElementById('calGrid');
    grid.innerHTML = '';
    const names = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    document.getElementById('calTitle').textContent = names[state.dateMonth] + ' ' + state.dateYear;
    const first = new Date(state.dateYear, state.dateMonth, 1).getDay();
    const days = new Date(state.dateYear, state.dateMonth + 1, 0).getDate();
    for (let i = 0; i < first; i++) grid.appendChild(document.createElement('div'));
    for (let d = 1; d <= days; d++) {
      const cell = document.createElement('div');
      cell.className = 'day-cell';
      cell.textContent = String(d);
      cell.addEventListener('click', () => {
        state.date = state.dateYear + '-' + String(state.dateMonth + 1).padStart(2,'0') + '-' + String(d).padStart(2,'0');
        setDateValue(state.date);
        document.getElementById('cal').style.display = 'none';
      });
      grid.appendChild(cell);
    }
  }
  document.getElementById('date').addEventListener('click', () => {
    document.getElementById('cal').style.display = 'block';
    renderCal();
  });
  document.querySelector('[aria-label="next month"]').addEventListener('click', () => {
    state.dateMonth += 1; if (state.dateMonth > 11) { state.dateMonth = 0; state.dateYear += 1; }
    renderCal();
  });
  document.querySelector('[aria-label="previous month"]').addEventListener('click', () => {
    state.dateMonth -= 1; if (state.dateMonth < 0) { state.dateMonth = 11; state.dateYear -= 1; }
    renderCal();
  });

  // Close pickers when clicking outside.
  document.addEventListener('click', (event) => {
    if (!event.target.closest('#tp') && !event.target.closest('#time')) closeTime();
  });

  // Locate the fixture so the browser renders it with real coordinates.
  document.getElementById('time').setAttribute('data-testid', 'time');
</script>
</body></html>`;

async function main() {
  const target = path.join(os.tmpdir(), "fake-tiktok-form.html");
  fs.writeFileSync(target, FORM_HTML);
  console.log("Wrote simulated form to", target);

  let playwright;
  try {
    playwright = require("playwright");
  } catch {
    console.log("playwright not installed; only wrote the fixture.");
    return;
  }
  const browser = await playwright.chromium.launch().catch(async () => {
    const chrome = ["/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => fs.existsSync(p));
    return chrome ? playwright.chromium.launch({ executablePath: chrome }) : null;
  });
  if (!browser) {
    console.log("No browser available; skipping live check.");
    return;
  }
  const page = await browser.newPage();
  await page.goto("file://" + target);

  // Drive the production helpers, not a hand copy, so the check stays honest.
  const uploader = require("../src/tiktok-uploader");
  const { _private } = uploader;

  await page.evaluate(() => {
    document.querySelector('input[value="schedule"]').checked = true;
    document.querySelector('input[value="schedule"]').dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForTimeout(200);

  const controls = await _private.findScheduleControls(page);
  console.log("controls:", JSON.stringify(controls));
  if (controls.length !== 2) { console.error("FAIL: expected time + date controls"); await browser.close(); process.exit(1); }

  const targetDate = new Date("2026-09-14T08:00:00.000Z"); // 10:00 Europe/Madrid
  await _private.setNativeSchedule(page, targetDate, "Europe/Madrid").catch((error) => {
    console.error("setNativeSchedule failed:", error.message);
  });

  const actual = await page.evaluate(() => ({ time: document.getElementById("time").value, date: document.getElementById("date").value }));
  console.log("final inputs:", JSON.stringify(actual));
  const ok = actual.time === "10:00" && actual.date === "2026-09-14";
  console.log(ok ? "PASS: schedule time and date were set correctly" : "FAIL: values did not match");

  await browser.close();
  process.exit(ok ? 0 : 1);
}

main().catch((error) => { console.error(error); process.exit(1); });
