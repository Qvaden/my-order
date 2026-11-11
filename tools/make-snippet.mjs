import { chromium } from 'playwright';
import fs from 'node:fs';

async function makeSnippet() {
  const src = 'assets/publish/cover-1200x628.png';
  const base64 = fs.readFileSync(src).toString('base64');
  const browser = await chromium.launch({ headless: true });
  const p = await browser.newPage({ viewport: { width: 1120, height: 630 } });
  await p.setContent(`<!DOCTYPE html><html><body style="margin:0;overflow:hidden;background:#060B18;display:flex;align-items:center;justify-content:center;"><img src="data:image/png;base64,${base64}" style="width:100%;height:100%;object-fit:cover;" /></body></html>`);
  await p.screenshot({ path: 'assets/publish/snippet-1120x630.png' });
  await browser.close();
  console.log('SUCCESS: snippet-1120x630.png generated');
}

makeSnippet().catch(console.error);
