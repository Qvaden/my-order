import { chromium } from 'playwright';
import fs from 'node:fs';

async function composeCover() {
  const bgJpg = 'C:/Users/Допель/.gemini/antigravity/brain/0c3ba11d-818c-4718-a7ad-eb38a574bd62/fintech_smart_home_ultra_banner_16x9_1794353455034.jpg';
  const destPng = 'assets/publish/cover-1200x628.png';
  const imgBase64 = fs.readFileSync(bgJpg).toString('base64');
  
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 628 } });
  
  await page.setContent(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            width: 1200px;
            height: 628px;
            overflow: hidden;
            position: relative;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #060B18;
          }
          .bg-art {
            position: absolute;
            top: 0;
            left: 0;
            width: 1200px;
            height: 628px;
            object-fit: cover;
            object-position: center center;
          }
          .overlay-gradient {
            position: absolute;
            top: 0;
            left: 0;
            width: 1200px;
            height: 628px;
            background: linear-gradient(90deg, rgba(6, 11, 24, 0.78) 0%, rgba(6, 11, 24, 0.55) 38%, rgba(6, 11, 24, 0.12) 52%, rgba(6, 11, 24, 0) 64%);
          }
          .content-left {
            position: absolute;
            top: 56px;
            left: 64px;
            width: 520px;
            z-index: 10;
          }
          .badge-row {
            display: inline-flex;
            align-items: center;
            gap: 10px;
            padding: 8px 18px;
            border-radius: 999px;
            background: linear-gradient(135deg, rgba(37, 99, 235, 0.28) 0%, rgba(15, 23, 42, 0.65) 100%);
            border: 1px solid rgba(147, 197, 253, 0.35);
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.25);
            backdrop-filter: blur(16px);
            margin-bottom: 22px;
          }
          .badge-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #10B981;
            box-shadow: 0 0 12px #10B981, 0 0 4px #6EE7B7;
          }
          .badge-text {
            color: #DBEAFE;
            font-size: 12.5px;
            font-weight: 800;
            letter-spacing: 1.5px;
            text-transform: uppercase;
          }
          .badge-pro {
            padding: 2px 8px;
            border-radius: 999px;
            background: linear-gradient(135deg, #FDE68A 0%, #F59E0B 100%);
            color: #0F172A;
            font-size: 11px;
            font-weight: 900;
            letter-spacing: 0.6px;
          }
          .title {
            font-size: 58px;
            font-weight: 900;
            line-height: 1.04;
            letter-spacing: -1.4px;
            color: #FFFFFF;
            margin-bottom: 14px;
            text-shadow: 0 8px 32px rgba(0, 0, 0, 0.65);
          }
          .title span {
            background: linear-gradient(135deg, #FEF08A 0%, #FBBF24 45%, #F59E0B 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            filter: drop-shadow(0 4px 18px rgba(245, 158, 11, 0.35));
          }
          .subtitle {
            font-size: 19.5px;
            font-weight: 500;
            line-height: 1.42;
            color: #E2E8F0;
            margin-bottom: 26px;
            text-shadow: 0 2px 12px rgba(0, 0, 0, 0.6);
          }
          .feature-grid {
            display: flex;
            flex-direction: column;
            gap: 11px;
            margin-bottom: 30px;
          }
          .feature-card {
            display: flex;
            align-items: center;
            gap: 13px;
            padding: 11px 16px;
            border-radius: 16px;
            background: linear-gradient(135deg, rgba(30, 41, 59, 0.68) 0%, rgba(15, 23, 42, 0.52) 100%);
            border: 1px solid rgba(148, 163, 184, 0.22);
            box-shadow: 0 8px 20px rgba(0, 0, 0, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.14);
            backdrop-filter: blur(14px);
          }
          .feature-icon {
            width: 28px;
            height: 28px;
            border-radius: 9px;
            background: linear-gradient(135deg, #3B82F6 0%, #1D4ED8 100%);
            border: 1px solid rgba(147, 197, 253, 0.6);
            box-shadow: 0 4px 12px rgba(37, 99, 235, 0.45);
            display: flex;
            align-items: center;
            justify-content: center;
            color: #FFFFFF;
            font-size: 14px;
            font-weight: 900;
            flex-shrink: 0;
          }
          .feature-icon.gold {
            background: linear-gradient(135deg, #FBBF24 0%, #D97706 100%);
            border-color: rgba(253, 230, 138, 0.75);
            box-shadow: 0 4px 12px rgba(245, 158, 11, 0.45);
            color: #0F172A;
          }
          .feature-text {
            color: #F8FAFC;
            font-size: 15.5px;
            font-weight: 600;
            letter-spacing: -0.1px;
          }
          .feature-text strong {
            color: #93C5FD;
            font-weight: 700;
          }
          .feature-text strong.gold-text {
            color: #FDE68A;
          }
          .cta-row {
            display: flex;
            align-items: center;
            gap: 16px;
          }
          .cta-pill {
            display: inline-flex;
            align-items: center;
            gap: 12px;
            padding: 15px 30px;
            background: linear-gradient(135deg, #3B82F6 0%, #2563EB 50%, #1D4ED8 100%);
            border: 1px solid rgba(191, 219, 254, 0.45);
            border-radius: 999px;
            color: #FFFFFF;
            font-size: 17px;
            font-weight: 800;
            letter-spacing: 0.2px;
            box-shadow: 0 14px 34px rgba(37, 99, 235, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.35);
          }
          .cta-arrow {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 24px;
            height: 24px;
            border-radius: 50%;
            background: rgba(255, 255, 255, 0.2);
            font-size: 13px;
          }
          .offline-pill {
            display: inline-flex;
            align-items: center;
            gap: 7px;
            padding: 10px 16px;
            border-radius: 999px;
            background: rgba(15, 23, 42, 0.65);
            border: 1px solid rgba(255, 255, 255, 0.14);
            color: #CBD5E1;
            font-size: 13.5px;
            font-weight: 600;
            backdrop-filter: blur(10px);
          }
        </style>
      </head>
      <body>
        <img class="bg-art" src="data:image/jpeg;base64,${imgBase64}" />
        <div class="overlay-gradient"></div>
        
        <div class="content-left">
          <div class="badge-row">
            <div class="badge-dot"></div>
            <span class="badge-text">VK Mini Apps · Умный Дом и Финансы</span>
            <span class="badge-pro">0+</span>
          </div>

          <h1 class="title">МОЙ <span>ПОРЯДОК</span></h1>
          <p class="subtitle">ЖКХ, платежи, документы, гарантии и семейный бюджет в одной премиальной экосистеме</p>

          <div class="feature-grid">
            <div class="feature-card">
              <div class="feature-icon">✓</div>
              <div class="feature-text">Счётчики по <strong>тарифам РФ</strong>, чек-листы и склад гарантий</div>
            </div>
            <div class="feature-card">
              <div class="feature-icon">✓</div>
              <div class="feature-text">Оплата по <strong>ГОСТ QR</strong> в любом банке и работа без сети</div>
            </div>
            <div class="feature-card">
              <div class="feature-icon gold">★</div>
              <div class="feature-text"><strong class="gold-text">PRO:</strong> Индекс порядка 0–100, ЖКХ-аудитор и копилка семьи</div>
            </div>
          </div>

          <div class="cta-row">
            <div class="cta-pill">
              <span>Открыть приложение</span>
              <span class="cta-arrow">➔</span>
            </div>
            <div class="offline-pill">
              <span>⚡ Бесплатно · Офлайн</span>
            </div>
          </div>
        </div>
      </body>
    </html>
  `);
  
  await page.screenshot({ path: destPng, clip: { x: 0, y: 0, width: 1200, height: 628 } });
  await browser.close();
  console.log('Successfully composed 1200x628 PNG cover to', destPng, 'size:', fs.statSync(destPng).size);
}

composeCover().catch(console.error);
