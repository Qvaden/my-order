import { chromium } from 'playwright';

const BASE = 'http://localhost:8080';

async function audit() {
  console.log('=== STARTING DEEP SYSTEM AUDIT ===');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    deviceScaleFactor: 2
  });
  const page = await context.newPage();

  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      errors.push(`Console error: ${msg.text()}`);
    }
  });
  page.on('pageerror', err => {
    errors.push(`Page error: ${err.message}`);
  });

  // 1. Load app as Owner (with full PRO unlocked)
  console.log('\n--- 1. Testing Owner auto-auth and Home screen ---');
  await page.goto(`${BASE}/?vk_user_id=519751085#home`);
  await page.waitForTimeout(600);

  // Check Home Score pill
  const homeScorePill = await page.$('#home-score-trigger');
  console.log('  Home score pill exists:', Boolean(homeScorePill));
  if (homeScorePill) {
    const text = await homeScorePill.innerText();
    console.log('  Home score text:', text.replace(/\n/g, ' '));
    await homeScorePill.click();
    await page.waitForTimeout(300);

    const achModal = await page.$('#achievements-modal');
    if (achModal) {
      const isVisible = await achModal.isVisible();
      const opacity = await achModal.evaluate(el => window.getComputedStyle(el).opacity);
      console.log('  Achievements modal visible:', isVisible, 'opacity:', opacity);
      if (opacity === '0') errors.push('Achievements modal has opacity: 0!');

      const closeBtn = await achModal.$('[data-action="close"]');
      if (closeBtn) await closeBtn.click();
      await page.waitForTimeout(300);
      console.log('  Achievements modal closed');
    } else {
      errors.push('Achievements modal failed to open!');
    }
  } else {
    errors.push('Home score trigger not found on #home!');
  }

  // Check Property pill
  console.log('\n--- 2. Testing Property Selector pill ---');
  const propPill = await page.$('.property-pill');
  console.log('  Property pill exists:', Boolean(propPill));
  if (propPill) {
    const text = await propPill.innerText();
    console.log('  Property pill text:', text.replace(/\n/g, ' '));
    await propPill.click();
    await page.waitForTimeout(300);

    const propModal = await page.$('#property-modal');
    if (propModal) {
      const isVisible = await propModal.isVisible();
      const opacity = await propModal.evaluate(el => window.getComputedStyle(el).opacity);
      console.log('  Property modal visible:', isVisible, 'opacity:', opacity);
      if (opacity === '0') errors.push('Property modal has opacity: 0!');

      const closeBtn = await propModal.$('[data-action="close"]');
      if (closeBtn) await closeBtn.click();
      await page.waitForTimeout(300);
      console.log('  Property modal closed');
    } else {
      errors.push('Property modal failed to open!');
    }
  } else {
    errors.push('Property pill not found in header!');
  }

  // Check Quick Add Bar in #tasks
  console.log('\n--- 3. Testing Tasks and Quick Add Bar ---');
  await page.goto(`${BASE}/#tasks`);
  await page.waitForTimeout(500);

  const voiceBtn = await page.$('[data-voice-btn]');
  console.log('  Voice button exists:', Boolean(voiceBtn));

  // Click empty add button -> should open task form
  const quickAddBtn = await page.$('[data-quick-btn]');
  if (quickAddBtn) {
    await quickAddBtn.click();
    await page.waitForTimeout(300);
    const taskModal = await page.$('.modal-overlay.is-open');
    console.log('  Empty quick-add opened modal:', Boolean(taskModal));
    if (taskModal) {
      const closeBtn = await taskModal.$('.modal-close, [data-action="close"], [data-task-action="cancel"]');
      if (closeBtn) await closeBtn.click();
      await page.waitForTimeout(300);
    } else {
      errors.push('Clicking empty quick-add in tasks did not open form!');
    }
  }

  // Check Payments and GOST QR
  console.log('\n--- 4. Testing Payments & GOST QR modal ---');
  await page.evaluate(() => {
    const overlays = document.querySelectorAll('.modal-overlay');
    overlays.forEach(o => o.parentNode && o.parentNode.removeChild(o));
    document.body.classList.remove('modal-open');
  });
  await page.goto(`${BASE}/#payments`);
  await page.waitForTimeout(500);

  // Add a test payment
  await page.evaluate(async () => {
    await window.DB.add('payments', {
      title: 'Тест квартплата ГОСТ',
      amount: 450000,
      category: 'housing',
      date: '2026-11-20',
      status: 'pending'
    });
    window.Payments.invalidate();
    window.Payments.render();
  });
  await page.waitForTimeout(400);

  const qrBtn = await page.$('[data-action="gost-qr"]');
  console.log('  GOST QR button exists:', Boolean(qrBtn));
  if (qrBtn) {
    // Check color before and on hover
    const btnColor = await qrBtn.evaluate(el => window.getComputedStyle(el).color);
    console.log('  QR button color:', btnColor);

    await qrBtn.click();
    await page.waitForTimeout(400);

    const qrOverlay = await page.$('.modal-overlay.is-open');
    console.log('  QR modal overlay open:', Boolean(qrOverlay));
    if (qrOverlay) {
      const opacity = await qrOverlay.evaluate(el => window.getComputedStyle(el).opacity);
      const svg = await qrOverlay.$('.gost-qr-code-wrap svg');
      console.log('  QR modal opacity:', opacity, 'SVG rendered:', Boolean(svg));
      if (opacity === '0') errors.push('QR modal has opacity: 0!');
      if (!svg) errors.push('QR modal does not contain SVG QR code!');

      const closeBtn = await qrOverlay.$('[data-gost-action="close"]');
      if (closeBtn) await closeBtn.click();
      await page.waitForTimeout(300);
      console.log('  QR modal closed');
    } else {
      errors.push('GOST QR modal failed to open or missing .is-open!');
    }
  } else {
    errors.push('GOST QR button not rendered in payments!');
  }

  // Check Backup & Tax Deduction
  console.log('\n--- 5. Testing Backup & Tax Deduction ---');
  await page.goto(`${BASE}/#backup`);
  await page.waitForTimeout(500);

  const taxBtn = await page.$('[data-backup-action="tax-deduction"]');
  console.log('  Tax deduction button exists:', Boolean(taxBtn));

  // Check PIN display in Backup
  const pinCells = await page.$$('.backup-pin__cell');
  console.log('  PIN matrix cells count:', pinCells.length);
  if (pinCells.length !== 4) {
    errors.push(`Expected 4 PIN cells, found ${pinCells.length}!`);
  }

  // Check All Navigation Hashes for Horizontal Overflow & Visual Glitches
  console.log('\n--- 6. Testing Horizontal Overflow on All Sections ---');
  const hashes = ['#home', '#payments', '#meters', '#documents', '#tasks', '#stats', '#backup'];
  for (const h of hashes) {
    await page.goto(`${BASE}/${h}`);
    await page.waitForTimeout(200);
    const scrollInfo = await page.evaluate(() => {
      const doc = document.documentElement;
      return {
        scroll: doc.scrollWidth,
        client: doc.clientWidth,
        diff: doc.scrollWidth - doc.clientWidth
      };
    });
    if (scrollInfo.diff > 1) {
      errors.push(`Horizontal scroll overflow on ${h}: diff=${scrollInfo.diff}px`);
    } else {
      console.log(`  [OK] ${h}: scrollWidth = clientWidth (${scrollInfo.client}px)`);
    }
  }

  await browser.close();

  console.log('\n=== AUDIT RESULTS ===');
  if (errors.length === 0) {
    console.log('ALL CHECKS PASSED: 0 ERRORS DETECTED!');
  } else {
    console.error(`ERRORS FOUND (${errors.length}):`);
    errors.forEach(e => console.error(`  - ${e}`));
    process.exit(1);
  }
}

audit().catch(err => {
  console.error('Audit script exception:', err);
  process.exit(1);
});
