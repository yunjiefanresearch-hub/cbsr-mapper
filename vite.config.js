import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base: './' makes all asset URLs relative, so the same build works at a domain root
// (Netlify / Vercel) AND at a GitHub Pages project subpath (username.github.io/repo/).
// If you deploy to a fixed subpath and prefer absolute URLs, set base: '/your-repo/'.
export default defineConfig({
  plugins: [react()],
  base: './',
})
