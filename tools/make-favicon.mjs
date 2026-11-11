import { chromium } from 'playwright';
import fs from 'node:fs';

async function makeFavicon() {
  const src = 'C:/Users/Допель/.gemini/antigravity/brain/0c3ba11d-818c-4718-a7ad-eb38a574bd62/app_icon_moy_poryadok_v2_1794353444182.jpg';
  const base64 = fs.readFileSync(src).toString('base64');
  const browser = await chromium.launch({ headless: true });
  const p = await browser.newPage({ viewport: { width: 32, height: 32 } });
  await p.setContent(`<!DOCTYPE html><html><body style="margin:0;overflow:hidden;background:#0B1329;display:flex;align-items:center;justify-content:center;"><img src="data:image/jpeg;base64,${base64}" style="width:100%;height:100%;object-fit:cover;" /></body></html>`);
  await p.screenshot({ path: 'assets/publish/favicon-32.png' });
  await browser.close();
  console.log('SUCCESS: favicon-32.png generated, size:', fs.statSync('assets/publish/favicon-32.png').size);
}

makeFavicon().catch(console.error);
