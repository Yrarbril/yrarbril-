// YRARBIL: QR-based library system, connected to a Supabase cloud database.
// The browser only talks to the database through the app_* functions in
// supabase/schema.sql. Each call sends the member's QR token, and the
// database checks it on the server.

// =====================================================================
// 1. CONFIG AND STATE
// =====================================================================

// The publishable key is meant to be public (it is visible in the browser).
// NEVER put a "secret" or "service_role" key in this file.
const SUPABASE_URL = "https://vfwzdhwjnfhkgpakmgrd.supabase.co";
const SUPABASE_KEY = "sb_publishable_FdNBh0kadQ2AhL0eo0HNQQ_znmssnkt";

const SESSION_KEY = "yrarbil-session";
const MAX_LOANS = 3; // only used for display; the database enforces the rule

let sessionToken = restoreSession(); // the logged-in member's QR token
let state = null;                    // data from the database: me, books, loans, log, members
let currentTab = "scan";
let searchText = "";
let cameraScanner = null;            // the live camera scanner, if running
let newlyRegistered = null;          // set right after sign-up to show the new card
let isBusy = false;                  // true while a database request is running


// =====================================================================
// 2. DATABASE CALLS
// =====================================================================

// Calls one of the app_* functions in the database and returns its result.
async function callApi(functionName, args) {
  const response = await fetch(SUPABASE_URL + "/rest/v1/rpc/" + functionName, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_KEY },
    body: JSON.stringify(args || {}),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((body && body.message) || "Request failed (" + response.status + ")");
  }
  return body;
}

// Reloads everything the screen needs for the logged-in member.
async function refresh() {
  state = await callApi("app_state", { p_token: sessionToken });
  if (!state) {            // token no longer valid
    sessionToken = null;
    saveSession();
  }
}

// Runs one action at a time and shows any error as a message.
async function run(task) {
  if (isBusy) return;
  isBusy = true;
  try {
    await task();
  } catch (error) {
    showToast(error.message || "Something went wrong.");
  }
  isBusy = false;
}

function restoreSession() {
  try { return sessionStorage.getItem(SESSION_KEY) || null; } catch (error) { return null; }
}

function saveSession() {
  try {
    if (sessionToken) sessionStorage.setItem(SESSION_KEY, sessionToken);
    else sessionStorage.removeItem(SESSION_KEY);
  } catch (error) { /* ignore */ }
}


// =====================================================================
// 3. HELPERS
// =====================================================================

const $ = (selector) => document.querySelector(selector);

const isAdmin = () => state && state.me.role === "admin";
const isOverdue = (loan) => new Date(loan.due_at) < new Date();
const myBooks = () => state.books.filter((book) => book.loan && book.loan.mine);

function formatDate(timestamp) {
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatDateTime(timestamp) {
  return new Date(timestamp).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// Stops user-typed text from being treated as HTML.
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text == null ? "" : String(text);
  return div.innerHTML;
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.style.display = "block";
  clearTimeout(showToast.timerId);
  showToast.timerId = setTimeout(() => { toast.style.display = "none"; }, 3200);
}


// =====================================================================
// 4. CORE LOGIC: what happens when a QR code is scanned
// =====================================================================

function handleScan(scannedText) {
  return run(() => processScan(scannedText));
}

async function processScan(scannedText) {
  const code = (scannedText || "").trim().toUpperCase();
  if (!code) return;

  // Nobody logged in: only a member card is accepted.
  if (!sessionToken) {
    await loginWithToken(code);
    return;
  }

  // Scanning your own card again logs you out.
  if (code === sessionToken) {
    await logout();
    return;
  }

  // Otherwise it should be a book label: borrow if free, return if you hold it.
  const book = state.books.find((item) => item.code === code);
  if (!book) { showToast("Unknown QR code."); return; }

  if (!book.loan) await borrowBook(book.code);
  else if (book.loan.mine || isAdmin()) await returnBook(book.code);
  else showToast("“" + book.title + "” is already borrowed.");
}

async function loginWithToken(token) {
  const member = await callApi("app_login", { p_token: token });
  if (!member) { showToast("Not a member card. Scan your YRARBIL card to log in."); return; }

  sessionToken = token;
  saveSession();
  newlyRegistered = null;
  currentTab = "scan";
  await refresh();
  showToast("Welcome, " + member.name.split(" ")[0] + "!");
  render();
}

async function logout() {
  try { await callApi("app_logout", { p_token: sessionToken }); } catch (error) { /* ignore */ }
  sessionToken = null;
  state = null;
  saveSession();
  showToast("You’re logged out.");
  render();
}

// Sign-up: the database creates the member and returns the new QR token.
async function registerUser(name) {
  newlyRegistered = await callApi("app_signup", { p_name: name });
  showToast("Account created for " + newlyRegistered.name + ".");
  render();
}

async function borrowBook(code) {
  const result = await callApi("app_borrow", { p_token: sessionToken, p_code: code });
  await refresh();
  showToast("Borrowed “" + result.title + "”. Due " + formatDate(result.due_at) + ".");
  render();
}

async function returnBook(code) {
  const result = await callApi("app_return", { p_token: sessionToken, p_code: code });
  await refresh();
  showToast("Returned “" + result.title + "”. Thank you!");
  render();
}

async function renewBook(bookId) {
  const result = await callApi("app_renew", { p_token: sessionToken, p_book_id: bookId });
  await refresh();
  showToast("Renewed. New due date: " + formatDate(result.due_at) + ".");
  render();
}

async function addBook(title, author, genre) {
  const result = await callApi("app_add_book", {
    p_token: sessionToken, p_title: title, p_author: author, p_genre: genre,
  });
  await refresh();
  showToast("Added. Its QR code is " + result.code + ".");
  render();
}


// =====================================================================
// 5. CAMERA SCANNING
// =====================================================================

function setCameraStatus(message) {
  const status = $("#camera-status");
  if (status) status.textContent = message;
}

function updateCameraButton() {
  const button = $("#camera-button");
  if (button) button.textContent = cameraScanner ? "Stop camera" : "Start camera";
}

// Turns a camera error into a message a person can act on.
function describeCameraError(error) {
  const name = (error && error.name) || "";
  const text = String(error);

  if (name === "NotAllowedError" || /permission|denied|not allowed/i.test(text)) {
    return "Camera access was blocked. Allow the camera for this site, or if the page is embedded, open it in its own tab. You can also use “Scan from photo”.";
  }
  if (name === "NotFoundError" || /no camera|not found/i.test(text)) {
    return "No camera was found on this device. Use “Scan from photo” or type a code.";
  }
  if (name === "NotReadableError") {
    return "The camera is in use by another app. Close it and try again.";
  }
  return "Couldn’t start the camera (" + (name || text) + "). Use “Scan from photo” or type a code.";
}

// Starts the live camera. Tapping the button again stops it.
async function startCamera() {
  if (cameraScanner) {
    await stopCamera();
    setCameraStatus("");
    return;
  }
  if (!$("#camera-view")) return;

  if (typeof Html5Qrcode === "undefined") {
    setCameraStatus("The scanner library didn’t load. Check your connection, or use “Scan from photo”.");
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setCameraStatus("This browser can’t use the camera here (it needs HTTPS). Use “Scan from photo”.");
    return;
  }

  setCameraStatus("Starting camera…");
  const scanner = new Html5Qrcode("camera-view");
  const config = { fps: 10, qrbox: { width: 220, height: 220 } };
  const onDecoded = (decodedText) => { stopCamera(); handleScan(decodedText); };
  const onNoCode = () => { /* ignore frames with no QR code */ };

  // Try the back camera first, then the front one (laptops only have a front camera).
  const cameraChoices = [{ facingMode: "environment" }, { facingMode: "user" }];
  let lastError = null;

  for (const choice of cameraChoices) {
    try {
      await scanner.start(choice, config, onDecoded, onNoCode);
      cameraScanner = scanner;
      setCameraStatus("Point the camera at a QR code.");
      updateCameraButton();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  setCameraStatus(describeCameraError(lastError));
}

async function stopCamera() {
  if (!cameraScanner) return;
  const scanner = cameraScanner;
  cameraScanner = null;
  try {
    await scanner.stop();
    scanner.clear();
  } catch (error) { /* already stopped */ }
  updateCameraButton();
}

// Fallback that works even when live camera access is blocked:
// take or choose a photo of a QR code and read it.
async function scanPhoto(file) {
  if (!file) return;
  if (typeof Html5Qrcode === "undefined") {
    setCameraStatus("The scanner library didn’t load. Type a code instead.");
    return;
  }

  await stopCamera();
  setCameraStatus("Reading photo…");
  try {
    const scanner = new Html5Qrcode("camera-view");
    const decodedText = await scanner.scanFile(file, false);
    setCameraStatus("");
    handleScan(decodedText);
  } catch (error) {
    setCameraStatus("No QR code found in that photo. Try again with the code filling more of the frame.");
  }
}


// =====================================================================
// 6. VIEWS: functions that return HTML
// =====================================================================

// A QR code card. "Simulate scan" lets you try the app without a camera.
function qrCardHtml(title, code, subtitleHtml, showSimulate) {
  return `
    <div class="qr-card">
      <div class="qr-image" data-qr="${escapeHtml(code)}"></div>
      <div class="qr-title">${escapeHtml(title)}</div>
      <div class="muted">${subtitleHtml}</div>
      ${showSimulate ? `<button data-action="simulate" data-scan="${escapeHtml(code)}" style="margin-top:6px">Simulate scan</button>` : ""}
    </div>`;
}

// Camera viewfinder, photo fallback (opens the gallery) and manual code entry.
function scannerHtml(placeholder) {
  return `
    <div id="camera-view"></div>
    <p id="camera-status" class="muted"></p>
    <div class="row">
      <button class="primary" data-action="camera" id="camera-button">Start camera</button>
      <button data-action="photo">Scan from photo</button>
      <input id="photo-input" type="file" accept="image/*" hidden>
    </div>
    <form data-form="manual" class="row" style="margin-top:8px">
      <input name="code" placeholder="${placeholder}">
      <button type="submit">Go</button>
    </form>`;
}

// Sign-up form, or the freshly created member card right after signing up.
function signUpCardHtml() {
  if (newlyRegistered) {
    return `
      <div class="card">
        <h2>Account created</h2>
        <p class="muted">This is your YRARBIL member card. Screenshot or print it: you scan it to log in.</p>
        <div class="qr-grid">${qrCardHtml(newlyRegistered.name, newlyRegistered.token, "member", false)}</div>
        <div class="row" style="margin-top:10px">
          <button class="primary" data-action="login-new">Log in now</button>
        </div>
      </div>`;
  }
  return `
    <div class="card">
      <h2>New member? Sign up</h2>
      <p class="muted">Enter your name to get your personal QR member card.</p>
      <form data-form="signup" class="row">
        <input name="name" placeholder="Your full name" autocomplete="name">
        <button class="primary" type="submit">Create card</button>
      </form>
    </div>`;
}

function authViewHtml() {
  return `
    <div class="card">
      <h2>Log in with your member card</h2>
      <p class="muted">Scan your card with the camera or a photo, or type the code under it.</p>
      ${scannerHtml("Type code, e.g. ANGELOCASTOR-7F3A")}
    </div>
    ${signUpCardHtml()}`;
}

function shortStatusHtml(book) {
  if (!book.loan) return `<span class="status-ok">Available</span>`;
  return `<span class="${isOverdue(book.loan) ? "status-danger" : "status-warning"}">Out</span>`;
}

function scanTabHtml() {
  const labels = state.books
    .map((book) => qrCardHtml(book.title, book.code, shortStatusHtml(book), true))
    .join("");

  return `
    <div class="card">
      <h2>Scan a book</h2>
      <p class="muted">A free book is borrowed on scan. Scan one you hold to return it. Scan your own member card to log out.</p>
      ${scannerHtml("Type code, e.g. HOBBIT-0005")}
    </div>
    <div class="card">
      <h2>Book labels</h2>
      <p class="muted">In a real library these QR labels are stuck inside each book.</p>
      <div class="qr-grid">${labels}</div>
    </div>`;
}

function bookRowHtml(book) {
  const loan = book.loan;
  let statusHtml = `<span class="status-ok">Available</span>`;
  let buttonHtml = `<button class="primary" data-action="borrow" data-code="${escapeHtml(book.code)}">Borrow</button>`;

  if (loan) {
    const cssClass = isOverdue(loan) ? "status-danger" : "status-warning";
    statusHtml = `<span class="${cssClass}">${loan.mine ? "You have this" : "Out"} · due ${formatDate(loan.due_at)}</span>`;
    buttonHtml = loan.mine
      ? `<button data-action="return" data-code="${escapeHtml(book.code)}">Return</button>`
      : `<button disabled>Unavailable</button>`;
  }

  return `
    <div class="book">
      <div>
        <div><span class="book-title">${escapeHtml(book.title)}</span><span class="tag">${escapeHtml(book.genre)}</span></div>
        <div class="muted">${escapeHtml(book.author)} · ${statusHtml}</div>
      </div>
      ${buttonHtml}
    </div>`;
}

// Only this list is redrawn while typing in the search box, so the box keeps focus.
function bookListHtml() {
  const query = searchText.trim().toLowerCase();
  const matches = state.books.filter((book) =>
    (book.title + " " + book.author + " " + book.genre).toLowerCase().includes(query)
  );
  return matches.length
    ? matches.map(bookRowHtml).join("")
    : `<p class="muted">No books match “${escapeHtml(searchText)}”.</p>`;
}

function catalogTabHtml() {
  return `
    <div class="card">
      <input id="search" placeholder="Search title, author or genre" value="${escapeHtml(searchText)}" style="width:100%;margin-bottom:6px">
      <div id="book-list">${bookListHtml()}</div>
    </div>`;
}

function myLoansTabHtml() {
  const mine = myBooks();
  if (!mine.length) {
    return `<div class="card"><h2>My loans</h2><p class="muted">Nothing borrowed right now. Scan a book to borrow it.</p></div>`;
  }

  const rows = mine.map((book) => `
    <tr>
      <td>${escapeHtml(book.title)}</td>
      <td class="${isOverdue(book.loan) ? "status-danger" : ""}">${formatDate(book.loan.due_at)}${isOverdue(book.loan) ? " (overdue)" : ""}</td>
      <td>
        <button data-action="renew" data-id="${book.id}" ${book.loan.renewals >= 1 || isOverdue(book.loan) ? "disabled" : ""}>Renew</button>
        <button data-action="return" data-code="${escapeHtml(book.code)}">Return</button>
      </td>
    </tr>`).join("");

  return `
    <div class="card">
      <h2>My loans (${mine.length}/${MAX_LOANS})</h2>
      <div class="table-scroll"><table><tr><th>Book</th><th>Due</th><th></th></tr>${rows}</table></div>
    </div>`;
}

function loanStatus(loan) {
  if (loan.returned_at) return { label: "Returned", cssClass: "status-ok" };
  if (isOverdue(loan)) return { label: "Overdue", cssClass: "status-danger" };
  return { label: "Out", cssClass: "status-warning" };
}

function adminTabHtml() {
  const loanRows = state.loans.map((loan) => {
    const status = loanStatus(loan);
    return `<tr>
      <td>${escapeHtml(loan.book_title)}</td>
      <td>${escapeHtml(loan.member_name)}</td>
      <td>${formatDate(loan.due_at)}</td>
      <td class="${status.cssClass}">${status.label}</td></tr>`;
  }).join("");

  const logRows = state.log.map((entry) =>
    `<tr><td>${formatDateTime(entry.at)}</td><td>${escapeHtml(entry.member_name || "—")}</td><td>${escapeHtml(entry.text)}</td></tr>`
  ).join("");

  const memberCards = state.members
    .map((member) => qrCardHtml(member.name, member.token, member.role === "admin" ? "librarian" : "member", false))
    .join("");

  return `
    <div class="card"><h2>All loans</h2>
      ${loanRows ? `<div class="table-scroll"><table><tr><th>Book</th><th>Member</th><th>Due</th><th>Status</th></tr>${loanRows}</table></div>` : `<p class="muted">No loans yet.</p>`}
    </div>
    <div class="card"><h2>Activity log</h2>
      ${logRows ? `<div class="table-scroll"><table><tr><th>When</th><th>Who</th><th>What</th></tr>${logRows}</table></div>` : `<p class="muted">No activity yet.</p>`}
    </div>
    <div class="card"><h2>Member cards</h2>
      <p class="muted">Print these for members. Treat them like keys: anyone with the QR can log in as that member.</p>
      <div class="qr-grid">${memberCards}</div>
    </div>
    <div class="card"><h2>Add a book</h2>
      <form data-form="add-book" class="row">
        <input name="title" placeholder="Title">
        <input name="author" placeholder="Author">
        <input name="genre" placeholder="Genre">
        <button class="primary" type="submit">Add</button>
      </form>
    </div>`;
}

function mainViewHtml() {
  const tabButton = (id, label) =>
    `<button data-action="tab" data-tab="${id}" class="${currentTab === id ? "active" : ""}">${label}</button>`;

  let html = `<div class="tabs">
    ${tabButton("scan", "Scan")}
    ${tabButton("catalog", "Catalog")}
    ${tabButton("mine", "My loans (" + myBooks().length + ")")}
    ${isAdmin() ? tabButton("admin", "Librarian") : ""}
  </div>`;

  if (currentTab === "scan") html += scanTabHtml();
  if (currentTab === "catalog") html += catalogTabHtml();
  if (currentTab === "mine") html += myLoansTabHtml();
  if (currentTab === "admin" && isAdmin()) html += adminTabHtml();
  return html;
}


// =====================================================================
// 7. RENDERING AND EVENTS
// =====================================================================

function drawQrCodes() {
  document.querySelectorAll("[data-qr]").forEach((element) => {
    element.innerHTML = "";
    try {
      new QRCode(element, { text: element.dataset.qr, width: 96, height: 96 });
    } catch (error) {
      element.textContent = element.dataset.qr; // fall back to plain text
    }
  });
}

function render() {
  stopCamera();

  const loggedIn = sessionToken && state;
  $("#user-info").innerHTML = loggedIn
    ? `<span class="muted">${escapeHtml(state.me.name)}${isAdmin() ? " · librarian" : ""}</span>
       <button data-action="logout">Log out</button>`
    : "";

  if (sessionToken && !state) $("#app").innerHTML = `<div class="card"><p class="muted">Loading…</p></div>`;
  else $("#app").innerHTML = loggedIn ? mainViewHtml() : authViewHtml();
  drawQrCodes();
}

// One click handler for every button, using data-action attributes.
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;

  switch (button.dataset.action) {
    case "tab":       currentTab = button.dataset.tab; render(); break;
    case "logout":    run(logout); break;
    case "camera":    startCamera(); break;
    case "photo":     $("#photo-input").click(); break;
    case "simulate":  handleScan(button.dataset.scan); break;
    case "login-new": run(() => loginWithToken(newlyRegistered.token)); break;
    case "borrow":    run(() => borrowBook(button.dataset.code)); break;
    case "return":    run(() => returnBook(button.dataset.code)); break;
    case "renew":     run(() => renewBook(Number(button.dataset.id))); break;
  }
});

// One submit handler for every form, using data-form attributes.
document.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form));

  switch (form.dataset.form) {
    case "manual":   form.reset(); handleScan(data.code || ""); break;
    case "signup":   run(() => registerUser(data.name || "")); break;
    case "add-book": run(() => addBook(data.title || "", data.author || "", data.genre || "")); break;
  }
});

// A photo was chosen: read the QR code from it.
document.addEventListener("change", (event) => {
  if (event.target.id !== "photo-input") return;
  scanPhoto(event.target.files[0]);
  event.target.value = "";
});

// Live search: redraw only the list, not the search box.
document.addEventListener("input", (event) => {
  if (event.target.id !== "search") return;
  searchText = event.target.value;
  $("#book-list").innerHTML = bookListHtml();
});

// Start: if a member is already logged in this session, load their data first.
async function start() {
  render();
  if (!sessionToken) return;
  try {
    await refresh();
  } catch (error) {
    sessionToken = null;
    saveSession();
    showToast("Couldn’t reach the database: " + error.message);
  }
  render();
}

start();
