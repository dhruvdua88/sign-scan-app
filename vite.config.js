import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base set for GitHub Project Pages: https://<user>.github.io/sign-scan-app/
export default defineConfig({
  base: '/sign-scan-app/',
  plugins: [react()],
})
