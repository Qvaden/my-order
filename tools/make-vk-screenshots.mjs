import { chromium } from 'playwright';
import fs from 'node:fs';

async function makeScreenshots600x1200() {
  const browser = await chromium.launch({ headless: true });
  const screens = [
    { src: 'assets/publish/screenshots/screenshot-1-home.png', dest: 'assets/publish/screenshots/screen-600x1200-1.png' },
    { src: 'assets/publish/screenshots/screenshot-2-payments.png', dest: 'assets/publish/screenshots/screen-600x1200-2.png' },
    { src: 'assets/publish/screenshots/screenshot-3-stats.png', dest: 'assets/publish/screenshots/screen-600x1200-3.png' },
    { src: 'assets/publish/screenshots/screenshot-4-family.png', dest: 'assets/publish/screenshots/screen-600x1200-4.png' },
    { src: 'assets/publish/screenshots/screenshot-5-dark-theme.png', dest: 'assets/publish/screenshots/screen-600x1200-5.png' },
  ];

  for (const item of screens) {
    const base64 = fs.readFileSync(item.src).toString('base64');
    const p = await browser.newPage({ viewport: { width: 600, height: 1200 } });
    await p.setContent(`<!DOCTYPE html><html><body style="margin:0;overflow:hidden;background:#0A0F1D;display:flex;align-items:center;justify-content:center;"><img src="data:image/png;base64,${base64}" style="width:100%;height:100%;object-fit:cover;" /></body></html>`);
    await p.screenshot({ path: item.dest });
    await p.close();
  }

  await browser.close();
  console.log('SUCCESS: All 5 600x1200 screenshots generated');
}

makeScreenshots600x1200().catch(console.error);
