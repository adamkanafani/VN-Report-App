# Tech Rep Report Builder — Setup Guide

This app runs on your own computer and reads your job folders directly, so
each tech rep needs their own copy running locally. It does **not** need an
internet connection to work (aside from the one-time download below), and it
does **not** need any API key or account.

## One-time setup (about 10 minutes)

### 1. Install Node.js

Go to **https://nodejs.org**, download the **LTS** version, and run the
installer. Click "Next" through every screen with the default options — you
don't need to change anything.

### 2. Install Git

Go to **https://git-scm.com/downloads**, download it for Windows, and run
the installer. Same as above — default options the whole way through are
fine.

*(Git is what lets you get one-click updates later with `Update.bat`,
instead of having to re-download everything by hand each time.)*

### 3. Download the app

Open a folder where you want the app to live — e.g. your Desktop or
Documents — right-click inside it, choose **"Open in Terminal"** (or
"Git Bash Here" if you see that option), and run:

```
git clone https://github.com/jzimmermann7/Tech-Rep-Report-App.git
```

This creates a new folder called `Tech-Rep-Report-App`. Open that folder.

### 4. Run setup

Double-click **`Setup - Run This First.bat`**. A black window will open and
do some work for a few minutes (this is normal, even if it looks like
nothing is happening for a bit). When it says "Setup complete!", you're
done — press any key to close the window.

## Using the app day-to-day

Double-click **`Start Report Builder.bat`**. Two things will happen:

- A window titled **"Tech Rep Report Builder - Server"** opens. **Leave this
  open** while you work (you can minimize it) — closing it shuts the app
  down. Close it when you're done for the day.
- Your web browser opens the app automatically a few seconds later.

That's it — pick your job folder like normal and work through the report.

## Getting updates

Whenever there's a new version of the app, double-click **`Update.bat`**
inside the app folder. It downloads the changes and rebuilds automatically.
This does **not** affect any reports you've already started reviewing —
your saved progress lives outside this folder and is untouched.

## A couple of things worth knowing

- **No internet needed day-to-day.** Once it's set up, the app runs
  entirely on your own computer.
- **No API key, no account, no login.** Nothing to configure.
- **Your job folders** — the app just needs to be able to browse to
  wherever your job folders already live (network drive, OneDrive, etc.),
  same as you'd browse to them in File Explorer.
- **Microsoft Excel** — if you have it installed, a couple of report
  sections (Height Dim Form, Dovetail) can embed the real completed form
  with its pictures instead of a plain data table, for jobs where that form
  only ever existed as a spreadsheet. This is optional — the app works fine
  without Excel, it just falls back to its own table for those cases.
