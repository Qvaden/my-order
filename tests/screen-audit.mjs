import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';

const BASE = 'http://localhost:8080';
const ARTIFACT_DIR = 'C:/Users/Допель/.gemini/antigravity/brain/0c3ba11d-818c-4718-a7ad-eb38a574bd62';

const VIEWPORTS = [
  { name: 'mobile-narrow-320', width: 320, height: 568 },
  { name: 'mobile-std-360', width: 360, height: 740 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'desktop-vk-911', width: 911, height: 700 }
];

const HASHES = ['#home', '#payments', '#meters', '#documents', '#tasks', '#backup'];

async function runAudit() {
  console.log('--- Starting Multi-Screen Visual & Functional Audit ---');
  const browser = await chromium.launch({ headless: true });
  const results = [];

  for (const vp of VIEWPORTS) {
    console.log(`\nTesting Viewport: ${vp.name} (${vp.width}x${vp.height})`);
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2
    });
    const page = await context.newPage();

    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', err => consoleErrors.push(err.message));

    // Test each main screen
    for (const hash of HASHES) {
      await page.goto(`${BASE}/${hash}`);
      await page.waitForTimeout(400);

      const overflow = await page.evaluate(() => {
        const doc = document.documentElement;
        const body = document.body;
        return {
          docScroll: doc.scrollWidth,
          docClient: doc.clientWidth,
          hasOverflow: doc.scrollWidth > doc.clientWidth + 1,
          bodyScroll: body.scrollWidth,
          bodyClient: body.clientWidth
        };
      });

      if (overflow.hasOverflow) {
        console.error(`  [OVERFLOW BUG] on ${vp.name} ${hash}: scrollWidth=${overflow.docScroll} > clientWidth=${overflow.docClient}`);
      } else {
        console.log(`  [OK] ${hash}: No horizontal overflow (${overflow.docClient}px)`);
      }

      // Check header buttons overlap
      const overlapCheck = await page.evaluate(() => {
        const header = document.querySelector('.header-actions');
        if (!header) return { exists: false, overlap: false };
        const buttons = Array.from(header.querySelectorAll('button'));
        let overlapping = false;
        for (let i = 0; i < buttons.length; i++) {
          for (let j = i + 1; j < buttons.length; j++) {
            const r1 = buttons[i].getBoundingClientRect();
            const r2 = buttons[j].getBoundingClientRect();
            // Check bounding box intersection
            const xOverlap = Math.max(0, Math.min(r1.right, r2.right) - Math.max(r1.left, r2.left));
            const yOverlap = Math.max(0, Math.min(r1.bottom, r2.bottom) - Math.max(r1.top, r2.top));
            if (xOverlap > 5 && yOverlap > 5) {
              overlapping = true;
            }
          }
        }
        return { exists: true, buttonsCount: buttons.length, overlap: overlapping };
      });

      if (overlapCheck.overlap) {
        console.error(`  [OVERLAP BUG] on ${vp.name} ${hash}: Header buttons are overlapping!`);
      } else if (overlapCheck.exists) {
        console.log(`  [OK] ${hash}: ${overlapCheck.buttonsCount} header buttons correctly laid out without overlap`);
      }

      // Capture screenshot for audit
      const screenPath = path.join(ARTIFACT_DIR, `audit-${vp.name}-${hash.replace('#','')}.png`);
      await page.screenshot({ path: screenPath });
    }

    await context.close();
  }

  // Functional test 1: Auto-PRO with ?vk_user_id=519751085
  console.log('\nTesting Functional Case 1: Owner Auto-PRO from URL params');
  const ownerContext = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const ownerPage = await ownerContext.newPage();
  await ownerPage.goto(`${BASE}/?vk_user_id=519751085#home`);
  await ownerPage.waitForTimeout(500);

  const ownerState = await ownerPage.evaluate(() => {
    return {
      isPro: window.ProManager ? window.ProManager.isPro() : false,
      tier: window.ProManager ? window.ProManager.tier() : null,
      activePlan: window.ProManager ? window.ProManager.getActivePlan().id : null,
      isOwner: window.ProManager ? window.ProManager.isOwner() : false,
      dataProAttr: document.documentElement.getAttribute('data-pro')
    };
  });
  console.log('  Owner Auto-PRO State:', JSON.stringify(ownerState));
  if (ownerState.isPro && ownerState.isOwner) {
    console.log('  [PASS] Owner 519751085 is automatically recognized as PRO and Owner!');
  } else {
    console.error('  [FAIL] Owner 519751085 was NOT automatically recognized as PRO/Owner!');
  }
  await ownerPage.screenshot({ path: path.join(ARTIFACT_DIR, 'audit-owner-autopro.png') });
  await ownerContext.close();

  // Functional test 2: Granting PRO with tariff in Owner Console without mutating own plan
  console.log('\nTesting Functional Case 2: Grant VIP with plan dropdown in Owner Console');
  const adminContext = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const adminPage = await adminContext.newPage();
  await adminPage.goto(`${BASE}/#backup`);
  await adminPage.waitForTimeout(400);

  // Set owner mode via ProManager directly
  await adminPage.evaluate(() => {
    localStorage.setItem('myorder_owner_unlocked', '1');
    window.ProManager.setOwnerPro('pro', 'month'); // Owner tests with 'month'
  });
  await adminPage.reload();
  await adminPage.waitForTimeout(400);

  // Verify owner is currently on month
  const initialPlan = await adminPage.evaluate(() => window.ProManager.getActivePlan().id);
  console.log('  Owner plan before granting:', initialPlan);

  // Open owner panel
  await adminPage.evaluate(() => {
    const ownerBtn = document.querySelector('[data-backup-action="owner-panel"]');
    if (ownerBtn) ownerBtn.click();
  });
  await adminPage.waitForTimeout(400);

  // Verify modal is open and has dropdown
  const modalInfo = await adminPage.evaluate(() => {
    const modal = document.querySelector('.modal-card');
    const select = modal ? modal.querySelector('[data-owner-input="vip-plan"]') : null;
    const input = modal ? modal.querySelector('[data-owner-input="vkid"]') : null;
    const btn = modal ? modal.querySelector('[data-owner-action="add-vip"]') : null;
    return {
      hasModal: Boolean(modal),
      hasPlanSelect: Boolean(select),
      hasVkidInput: Boolean(input),
      hasAddBtn: Boolean(btn)
    };
  });
  console.log('  Owner Modal Elements:', JSON.stringify(modalInfo));

  // Grant 1 year to user 999888777
  await adminPage.evaluate(() => {
    const select = document.querySelector('[data-owner-input="vip-plan"]');
    const input = document.querySelector('[data-owner-input="vkid"]');
    const btn = document.querySelector('[data-owner-action="add-vip"]');
    if (select) select.value = 'year';
    if (input) input.value = '999888777';
    if (btn) btn.click();
  });
  await adminPage.waitForTimeout(400);

  // Check VIP entries and owner plan
  const verifyResult = await adminPage.evaluate(() => {
    const pm = window.ProManager;
    return {
      ownerPlanAfter: pm.getActivePlan().id,
      vipPlanForUser: pm.getVipPlan('999888777'),
      isVip: pm.isVipVkId('999888777'),
      vipEntries: pm.getVipEntries()
    };
  });
  console.log('  VIP Result:', JSON.stringify(verifyResult));

  if (verifyResult.ownerPlanAfter === initialPlan && verifyResult.vipPlanForUser === 'year') {
    console.log('  [PASS] Granted 1 year to 999888777 WITHOUT modifying owner plan (still month)!');
  } else {
    console.error('  [FAIL] Owner plan was mutated or user plan was not recorded correctly!');
  }

  await adminPage.screenshot({ path: path.join(ARTIFACT_DIR, 'audit-owner-modal-grant.png') });
  await adminContext.close();

  await browser.close();
  console.log('--- Multi-Screen Visual & Functional Audit Completed ---');
}

runAudit().catch(err => {
  console.error('Audit failed:', err);
  process.exit(1);
});
