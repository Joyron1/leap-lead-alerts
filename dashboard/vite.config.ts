import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Fixed port so the app always opens at the same address (and a browser-installed app keeps working).
// 3000 is taken by another local project on this machine. Add http://localhost:5180 to Supabase
// Auth → URL Configuration → Redirect URLs so the "confirm your email" link comes back here.
export default defineConfig({
  plugins: [react()],
  server: { port: 5180, strictPort: true },
  preview: { port: 5180, strictPort: true },
});
