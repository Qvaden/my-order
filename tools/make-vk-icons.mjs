import { chromium } from 'playwright';
import fs from 'node:fs';

async function makeIcons() {
  const src = 'C:/Users/Допель/.gemini/antigravity/brain/0c3ba11d-818c-4718-a7ad-eb38a574bd62/app_icon_moy_poryadok_v2_1794353444182.jpg';
  const base64 = fs.readFileSync(src).toString('base64');
  const browser = await chromium.launch({ headless: true });

  const p1 = await browser.newPage({ viewport: { width: 576, height: 576 } });
  await p1.setContent(`<!DOCTYPE html><html><body style="margin:0;overflow:hidden;background:#0B1329;display:flex;align-items:center;justify-content:center;"><img src="data:image/jpeg;base64,${base64}" style="width:100%;height:100%;object-fit:cover;" /></body></html>`);
  await p1.screenshot({ path: 'assets/publish/icon-576.png' });

  const p2 = await browser.newPage({ viewport: { width: 278, height: 278 } });
  await p2.setContent(`<!DOCTYPE html><html><body style="margin:0;overflow:hidden;background:#0B1329;display:flex;align-items:center;justify-content:center;"><img src="data:image/jpeg;base64,${base64}" style="width:100%;height:100%;object-fit:cover;" /></body></html>`);
  await p2.screenshot({ path: 'assets/publish/icon-278.png' });

  await browser.close();
  console.log('SUCCESS: icon-576.png and icon-278.png generated');
}

makeIcons().catch(console.error);
