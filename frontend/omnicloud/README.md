# OmniCloud frontend

## Vercel deployment

Connect the frontend repository to Vercel with the repository root as the project root. Vercel detects the Vite app; the build command is `npm run build` and the output directory is `dist`. `vercel.json` proxies `/api/*` to the Render backend and sends SPA paths to `index.html`.

Set the Render backend's `OMNICLOUD_PUBLIC_URL` to the final Vercel HTTPS origin. AWS uses device authorization, so no OAuth callback URI is needed. The API proxy keeps sign-in requests on the Vercel origin.

## Netlify deployment (alternative)

Connect this repository to Netlify and use its root directory as the site root. `netlify.toml` configures `npm ci && npm run build`, publishes `dist`, proxies `/api/*` to the Render API, and sends other paths to the SPA entry point. Create the Render service first and update the API hostname in `netlify.toml` if Render assigned a different service URL.

After Netlify assigns the final HTTPS site URL, set that exact origin as the backend's `OMNICLOUD_PUBLIC_URL`. AWS uses device authorization, so no OAuth callback URI is needed. The API proxy keeps sign-in requests on the Netlify origin.

Use Node.js 22 for Netlify builds. The frontend uses relative `/api` requests, so do not set a separate browser API URL or expose backend secrets in frontend environment variables.
