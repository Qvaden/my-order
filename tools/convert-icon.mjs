import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

async function convertToIconPng() {
  const srcJpg = 'C:/Users/Допель/.gemini/antigravity/brain/0c3ba11d-818c-4718-a7ad-eb38a574bd62/app_icon_moy_poryadok_v2_1794353444182.jpg';
  const destPng = 'assets/publish/icon-512.png';
  const imgBase64 = fs.readFileSync(srcJpg).toString('base64');
  
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
  await page.setContent(`
    <!DOCTYPE html>
    <html>
      <head>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { width: 512px; height: 512px; overflow: hidden; background: #0B1329; display: flex; align-items: center; justify-content: center; }
          img { width: 100%; height: 100%; object-fit: cover; }
        </style>
      </head>
      <body>
        <img src="data:image/jpeg;base64,${imgBase64}" />
      </body>
    </html>
  `);
  await page.screenshot({ path: destPng, clip: { x: 0, y: 0, width: 512, height: 512 } });
  await browser.close();
  console.log('Successfully saved 512x512 PNG icon to', destPng, 'size:', fs.statSync(destPng).size);
}

convertToIconPng().catch(console.error);
