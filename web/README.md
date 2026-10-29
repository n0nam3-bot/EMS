# Web app

The four consoles (`src/consoles/`), unmodified from the versions that were reviewed, hosted in a small Vite + React + Tailwind project.

    npm ci
    npm run dev      # local development server
    npm test         # render tests (jsdom)
    npm run build    # static site into dist/

`src/storage-shim.js` exists because the consoles were written for Claude's preview, which provides a `window.storage` key-value API that no other environment has. Without the shim the dispatch and ePCR consoles show a blank page (a test demonstrates this).

Each console runs on demo data until you give it an API URL and a token (see `../DEPLOYMENT.md`). Known limits outside Claude: the ePCR "Draft from Chart Data" and "Clean Up My Writing" buttons call Anthropic's API directly from the browser with no key, so they cannot work until the API proxies them; the live map and route estimates need internet access.
