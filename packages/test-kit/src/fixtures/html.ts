/**
 * HTML fixture corpus for page-extraction tests — real DOMs parsed under
 * happy-dom so @mozilla/readability + the state probe run against realistic
 * markup, not mocks. Exported as strings; tests parse via DOMParser.
 */

/** A real article page: readable body + full metadata (og/canonical/lang). */
export const ARTICLE_HTML = `<!doctype html>
<html lang="en-GB">
<head>
  <title>The Tab That Remembered — browser-tab</title>
  <meta name="description" content="How a daemon turned a topology reader into a perception API.">
  <meta property="og:title" content="The Tab That Remembered">
  <meta property="og:description" content="A short field note on event-sourced browser memory.">
  <meta property="og:image" content="https://example.com/cover.png">
  <meta property="og:site_name" content="browser-tab journal">
  <link rel="canonical" href="https://example.com/the-tab-that-remembered">
</head>
<body>
  <header><nav>Home · Archive · About</nav></header>
  <article>
    <h1>The Tab That Remembered</h1>
    <p class="byline">By Ada Lorenz</p>
    <p>For a long time the window manager only knew which tabs existed and where.
       It could list them, focus them, and move them, but it had no memory of where
       the user had actually been. That gap is what the journal closes.</p>
    <p>Every focus change and committed navigation is appended to a small ring, then
       flushed to disk in one-write-per-second batches. Because handles are not stable
       across generations, each record denormalizes the URL and title so the history
       survives id churn entirely.</p>
    <p>The subtler win is the epoch. A per-tab navigation counter, bumped whenever a
       page commits, becomes the cache-busting key that later content and screenshot
       caches hang off of. Nothing else in the system needs to know how it is computed.</p>
    <p>None of this involves any intelligence in the tool itself. It returns text,
       state, and raw signals; the consumer on the other side decides what they mean.</p>
  </article>
  <footer><p>© 2026 browser-tab journal</p></footer>
</body>
</html>`;

/** A page whose form fields the test mutates to exercise dirty-form counting. */
export const DIRTY_FORM_HTML = `<!doctype html>
<html lang="en">
<head><title>Compose</title></head>
<body>
  <form id="compose">
    <input id="subject" name="subject" type="text" value="">
    <textarea id="body" name="body"></textarea>
    <input id="urgent" name="urgent" type="checkbox">
    <button type="submit">Send</button>
  </form>
  <form id="search">
    <input id="q" name="q" type="text" value="">
  </form>
</body>
</html>`;

/** A page with playing/paused media for the media probe. */
export const MEDIA_HTML = `<!doctype html>
<html lang="en">
<head><title>Now Playing</title></head>
<body>
  <video id="clip" src="https://example.com/clip.mp4"></video>
  <audio id="track" src="https://example.com/track.mp3"></audio>
</body>
</html>`;

/** A JS-shell SPA with no article content — Readability should find nothing. */
export const SPA_HTML = `<!doctype html>
<html lang="en">
<head><title>Loading…</title></head>
<body>
  <div id="root"></div>
  <noscript>You need to enable JavaScript to run this app.</noscript>
</body>
</html>`;
