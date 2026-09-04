# 🎬 PowerFlicks

### A modern movie discovery platform built with Flask, JavaScript, SQLite, and the TMDB API.

PowerFlicks is a full-stack movie discovery web application designed to make finding movies more engaging and personalized.

It combines live movie data from TMDB with search, discovery, movie details, recommendations, watchlists, community reviews, ratings, and movie-personality features in a single interface.

---

## 🔗 Links

- **Live Demo:** https://powerflicks-movie-recommendation-website.onrender.com
- **GitHub:** https://github.com/yepuriakash/PowerFlicks--Movie-Recommendation-Website

---

## 📸 Screenshots

> Add screenshots of the application here.

### Home & Movie Discovery

![PowerFlicks Home](screenshots/home.png)

### Movie Details

![PowerFlicks Movie Details](screenshots/movie-details.png)

### Watchlist & Community Reviews

![PowerFlicks Watchlist](screenshots/watchlist.png)

---

## 📖 Project Overview

PowerFlicks was built as a full-stack movie discovery application with a focus on combining a polished frontend experience with a backend that handles external API communication and persistent user data.

The application retrieves current movie information from the TMDB API while keeping the API credential on the server rather than exposing it to browser-side JavaScript.

The Flask backend also provides application-specific API routes for features such as watchlists and community reviews, with SQLite providing local data persistence.

---

## ✨ Key Features

- 🎬 Movie discovery using current TMDB data
- 🔎 Movie search
- ⭐ Movie ratings and popularity information
- 🎭 Cast and movie details
- 🎞️ Movie recommendations
- 📋 Per-device watchlists
- 💬 Community movie reviews
- ⭐ User-submitted review ratings
- 🎂 Movie personality / birthday spotlight features
- 🖼️ Dynamic posters and backdrops
- ⚡ Backend caching for frequently requested TMDB data
- 🛡️ Server-side API credential handling
- ✅ Input validation
- 🗄️ SQLite-backed persistent application data
- 📱 Responsive movie-focused interface

---

## ⚙️ How PowerFlicks Works

PowerFlicks uses a backend-first architecture.

The browser communicates with the Flask backend instead of directly communicating with TMDB.

```text
                         ┌──────────────┐
                         │     User     │
                         └──────┬───────┘
                                │
                                ▼
                     ┌────────────────────┐
                     │ PowerFlicks        │
                     │ Frontend           │
                     │ HTML / CSS / JS    │
                     └─────────┬──────────┘
                               │
                               ▼
                     ┌────────────────────┐
                     │ Flask Backend      │
                     │      app.py        │
                     └─────────┬──────────┘
                               │
                  ┌────────────┴────────────┐
                  ▼                         ▼
        ┌──────────────────┐       ┌──────────────────┐
        │ TMDB API         │       │ SQLite Database  │
        │                  │       │                  │
        │ Movies           │       │ Watchlist        │
        │ Cast             │       │ Reviews          │
        │ Search           │       │                  │
        │ Recommendations  │       │                  │
        └──────────────────┘       └──────────────────┘
