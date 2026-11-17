# YRARBIL: QR-based library system

A small, dependency-free prototype of a library where members log in by scanning a QR member card, and borrow or return books by scanning the QR label on each book. The page is plain HTML, CSS and JavaScript, and it stores members, books and loans in a [Supabase](https://supabase.com) cloud database.

## Features

- **QR login and logout:** scan your member card to log in, scan it again to log out.
- **Borrow and return by scan:** scan a free book to borrow it, scan one you hold to return it.
- **Sign up:** enter a name and get a personal QR member card.
- **Catalog and loans:** search books, see due dates, renew once, overdue highlighting.
- **Librarian view:** all loans, activity log, printable member cards, add books.
- **Camera, photo or typed code:** live camera scanning, "Scan from photo" (opens your gallery), or type a code.

## QR code format

| Type   | Format                                  | Example         |
| ------ | --------------------------------------- | --------------- |
| Member | letters of the name + random hex        | `ANGELOCASTOR-7F3A` |
| Book   | first letters of the title + book number | `HOBBIT-0005`   |

## Demo cards

Open the app and use the "Simulate scan" buttons, or scan the QR codes shown on screen.

| Name       | Role      | Code             |
| ---------- | --------- | ---------------- |
| Angelo Castor  | member    | `ANGELOCASTOR-7F3A`  |
| Junalyn Nebria  | member (has an overdue book) | `JUNALYNNEBRIA-B20C` |
| Joshua Magalo | librarian | `JOSHUAMAGALO-AD11` |

## Set up the Supabase database

1. Create a project at [supabase.com](https://supabase.com).
2. Open **SQL Editor > New query**, paste the whole of `supabase/schema.sql`, and click **Run**. This creates the tables, locks them down, adds the `app_*` functions the website calls, and inserts the demo data.
3. In **Project Settings > API** copy the **Project URL** and the **publishable key**.
4. Put them at the top of `script.js` (`SUPABASE_URL` and `SUPABASE_KEY`).

The publishable key is designed to be public. **Never** put the `secret` or `service_role` key in the website code.

## Run locally

Camera access needs HTTPS or `localhost`, so serve the folder instead of opening the file directly:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Deploy with GitHub Pages (free HTTPS)

1. Push this folder to a GitHub repository (see below).
2. In the repository go to **Settings > Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, pick `main` and `/ (root)`, then save.
4. After a minute your site is live at `https://<your-username>.github.io/<repository-name>/`.

## Upload to GitHub

**Using the website:** create a new repository, click **Add file > Upload files**, drag in everything from this folder (not the folder itself), and commit.

**Using git:**

```bash
git init
git add .
git commit -m "Add YRARBIL QR library prototype"
git branch -M main
git remote add origin https://github.com/<your-username>/<repository-name>.git
git push -u origin main
```

## Project structure

```
index.html   page structure, loads the libraries, styles and script
style.css    all styling (light and dark themes)
script.js    database calls, scan logic, camera, views and events
supabase/schema.sql   database tables, security rules and functions (run once in Supabase)
LICENSE      MIT license
README.md    this file
```

## Security notes (read before real use)

- The tables cannot be read or written directly from the browser. Every action goes through a database function that checks the member's QR token on the server.
- Anyone who has a member's QR code can log in as that member, so treat cards like keys. For stronger security add a PIN or short-lived rotating codes.
- Anyone can sign up (there is no approval step), and login attempts are not rate limited. Consider approval and rate limiting before a real launch.
- Back up your data from the Supabase dashboard.

## Third-party libraries (loaded from cdnjs)

- [qrcodejs](https://github.com/davidshimjs/qrcodejs), MIT license, generates QR codes.
- [html5-qrcode](https://github.com/mebjas/html5-qrcode), Apache 2.0 license, scans QR codes.

## License

MIT, see [LICENSE](LICENSE).
