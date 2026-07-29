// ==========================================
// CONFIGURATION & CONSTANTS
// ==========================================
const CHANNEL_ACCESS_TOKEN = "PT37Wr/xV+py61KhKIZrCwRLw9fzPPOD0iZ00yFXB3aI6R6iGHJSEu2Pa5MYyfShBq9V5ZwuYEQDAow3XDUdnUfDnNV/ShD+WXC2mCByEXmu7ckWCQPxI53/72NW8EBfk+NdtcyExD9FhCdQB4ekGwdB04t89/1O/w1cDnyilFU=";
const MAIN_FOLDER_NAME = "interview";
const RENDER_OCR_URL = "https://passport-ocr-bot1.onrender.com/ocr";
const RENDER_OCR_SUBMIT_URL = "https://passport-ocr-bot1.onrender.com/ocr/submit";
const SECRET_TOKEN = "hkt12345604";
const IMAGE_BATCH_DEBOUNCE_MS = 5000; // ข้อ 4: หน่วงเวลารวมรูปก่อนตอบกลับครั้งเดียว กันตอบถี่ๆ ทีละรูป (นับจากรูปล่าสุดที่เข้ามาแต่ละรอบ)

// ==========================================
// DEBUG LOGGING (เขียนลง Google Sheet ชื่อ "BOT_DEBUG_LOG" ให้เปิดดูง่ายๆ โดยไม่ต้องเข้า Apps Script Executions)
// ==========================================
function debugLog(message) {
  try {
    Logger.log(message);
    const sheet = getOrCreateDebugLogSheet();
    sheet.appendRow([new Date(), String(message)]);
  } catch (e) {
    Logger.log('debugLog failed: ' + e);
  }
}

function getOrCreateDebugLogSheet() {
  const files = DriveApp.getFilesByName('BOT_DEBUG_LOG');
  let ss;
  if (files.hasNext()) {
    ss = SpreadsheetApp.open(files.next());
  } else {
    ss = SpreadsheetApp.create('BOT_DEBUG_LOG');
  }
  let sheet = ss.getSheetByName('LOG');
  if (!sheet) {
    sheet = ss.insertSheet('LOG');
    sheet.appendRow(['Timestamp', 'Message']);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// ==========================================
// CONCURRENCY (LockService)
// ==========================================
// ครอบ read-modify-write ที่เสี่ยงชนกันเมื่อมีหลายคนใช้งานพร้อมกัน
// พยายามรอ lock 10 วิ ถ้าไม่ได้ retry อีกครั้ง (รอ 5 วิ) ก่อนจะ throw error ให้ผู้ใช้ลองใหม่เอง
function withLock(fn) {
  const lock = LockService.getScriptLock();
  let acquired = lock.tryLock(10000);
  if (!acquired) {
    debugLog('withLock: ไม่ได้ lock ในรอบแรก กำลัง retry...');
    acquired = lock.tryLock(5000);
  }
  if (!acquired) {
    debugLog('withLock: ไม่ได้ lock หลัง retry แล้ว');
    throw new Error('ระบบกำลังประมวลผลรายการอื่นอยู่ กรุณาลองใหม่อีกครั้งครับ');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ==========================================
// BOOKED SEQ TRACKING (ต่อ userName — ใช้โชว์รายการ SEQ ที่จองไว้แต่ยังไม่จบงาน)
// ==========================================
// เก็บแยกจากคอลัมน์ E ของ SUMMARY เพราะคอลัมน์ E ถูก importOcrResult() เขียนทับด้วยเลข Passport
// หลัง OCR สำเร็จ ทำให้ข้อความ "จองโดย {userName}" หายไปก่อนงานจะจบจริง (ก่อนกด "จบงาน")
function bookedSeqPropertyKey(sheetId, userName) {
  return `BOOKED_${sheetId}_${userName}`;
}

function getUserBookedSeqs(sheetId, userName) {
  const raw = PropertiesService.getScriptProperties().getProperty(bookedSeqPropertyKey(sheetId, userName));
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch (e) {
    return [];
  }
}

function addBookedSeqs(sheetId, userName, seqs) {
  const scriptProperties = PropertiesService.getScriptProperties();
  const current = getUserBookedSeqs(sheetId, userName);
  const merged = current.concat(seqs.filter(s => !current.includes(s)));
  scriptProperties.setProperty(bookedSeqPropertyKey(sheetId, userName), JSON.stringify(merged));
}

function removeBookedSeq(sheetId, userName, seq) {
  if (!sheetId || !userName || !seq) return;
  const scriptProperties = PropertiesService.getScriptProperties();
  const remaining = getUserBookedSeqs(sheetId, userName).filter(s => String(s) !== String(seq));
  const key = bookedSeqPropertyKey(sheetId, userName);
  if (remaining.length === 0) {
    scriptProperties.deleteProperty(key);
  } else {
    scriptProperties.setProperty(key, JSON.stringify(remaining));
  }
}

// ข้อความรายการ SEQ ที่ผู้ใช้คนนี้จองไว้แต่ยังไม่จบงาน (คืนสตริงว่างถ้าไม่มี ไม่ต้องแสดงหัวข้อเปล่าๆ)
function formatBookedSeqListText(sheetId, userName) {
  const bookedSeqs = getUserBookedSeqs(sheetId, userName);
  if (bookedSeqs.length === 0) return '';
  return `📋 SEQ ที่คุณจองไว้ (ยังไม่จบงาน): ${bookedSeqs.join(', ')}\n\n`;
}

// ==========================================
// MAIN WEBHOOK (doPost)
// ==========================================
function doPost(e) {
  try {
    debugLog('doPost received. parameter=' + JSON.stringify(e && e.parameter) + ' bodyLength=' + (e && e.postData ? e.postData.contents.length : 'NO_POSTDATA'));

    if (!e.parameter || e.parameter.token !== SECRET_TOKEN) {
      debugLog('doPost unauthorized. received token=' + (e && e.parameter && e.parameter.token));
      return ContentService.createTextOutput(JSON.stringify({ status: 'unauthorized' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const body = JSON.parse(e.postData.contents);
    debugLog('doPost body parsed. action=' + body.action + ' eventsCount=' + (body.events ? body.events.length : 0));

    // Callback จาก app.py หลังประมวลผล OCR แบบ background เสร็จ
    if (body.action === 'ocr_callback') {
      handleOcrCallback(body);
      return ContentService.createTextOutput(JSON.stringify({ status: 'ok' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // คำขอจากหน้า popup ที่เปิดใน in-app browser ของ LINE (ข้อ 5 และ 6) — sheetId/seq/uid/sheetName อยู่ใน
    // query string เดียวกับ URL ของหน้า popup (e.parameter) ส่วนข้อมูลที่กรอกจริงอยู่ใน JSON body
    if (body.action === 'save_photo_classification') {
      return handleSavePhotoClassification(e, body);
    }
    if (body.action === 'defer_photo_classification') {
      return handleDeferPhotoClassification(e);
    }
    if (body.action === 'save_summary_extra') {
      return handleSaveSummaryExtra(e, body);
    }

    const events = body.events || [];
    for (const event of events) {
      try {
        handleEvent(event);
      } catch (eventErr) {
        debugLog('handleEvent Error: ' + eventErr);
        const userId = event.source && event.source.userId;
        if (userId) {
          pushText(userId, `❌ เกิดข้อผิดพลาดขณะประมวลผล: ${eventErr.message}`);
        }
      }
    }
    return ContentService.createTextOutput(JSON.stringify({ status: 'ok' }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    debugLog('doPost Error: ' + err);
    return ContentService.createTextOutput(JSON.stringify({ status: 'error', message: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ==========================================
// POPUP WEB APP (doGet) — ข้อ 5 (จัดการรูปภาพ) และข้อ 6 (ข้อมูลเพิ่มเติม SUMMARY)
// ==========================================
// แทนที่จะใช้ LIFF (ต้องแยก LINE Login channel ต่างหาก ผูกกับ Messaging API channel ไม่ได้แล้ว)
// ใช้วิธีเปิดลิงก์ URL ธรรมดา (action type "uri") ให้ LINE เปิดใน in-app browser ของมันเอง
// หน้าเว็บ (doGet) กับ API ที่หน้าเว็บเรียกกลับมา (doPost) เป็น URL เดียวกัน จึงเป็น same-origin ไม่มีปัญหา CORS
function doGet(e) {
  const page = e.parameter && e.parameter.page;
  if (!e.parameter || e.parameter.token !== SECRET_TOKEN) {
    return HtmlService.createHtmlOutput('<p>Unauthorized</p>');
  }
  if (page === 'manage_photos') {
    return renderManagePhotosPage(e);
  }
  if (page === 'extra_info') {
    return renderExtraInfoPage(e);
  }
  return HtmlService.createHtmlOutput('<p>Not found</p>');
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function getWebAppUrl() {
  return ScriptApp.getService().getUrl();
}

// สร้าง URL ของหน้า popup พร้อม token กันเข้าถึงโดยไม่ได้รับอนุญาต — sheetId/seq/uid อยู่ใน query string
// เพื่อให้หน้าเว็บ POST กลับมาที่ location.href ตรงๆ ได้เลยโดยไม่ต้องแนบซ้ำ (doPost เช็ค token จาก e.parameter อยู่แล้ว)
function buildPopupUrl(page, params) {
  const query = Object.keys(params)
    .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(params[key] || '')}`)
    .join('&');
  return `${getWebAppUrl()}?page=${encodeURIComponent(page)}&token=${encodeURIComponent(SECRET_TOKEN)}&${query}`;
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// CSS ร่วมของหน้า popup ทั้งสองแบบ (ข้อ 5/6) — ดีไซน์เรียบทันสมัย รองรับจอมือถือเป็นหลัก
const POPUP_SHARED_STYLE = `
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f4f5f7; color: #1a1a1a; padding-bottom: 96px; }
  header { position: sticky; top: 0; background: #06c755; color: #fff; padding: 14px 16px; font-weight: 700; font-size: 16px; box-shadow: 0 2px 6px rgba(0,0,0,.08); z-index: 10; }
  header small { display: block; font-weight: 400; font-size: 12px; opacity: .9; margin-top: 2px; }
  .container { padding: 12px; max-width: 640px; margin: 0 auto; }
  .card { background: #fff; border-radius: 14px; box-shadow: 0 1px 4px rgba(0,0,0,.08); margin-bottom: 12px; overflow: hidden; }
  .footer-bar { position: fixed; bottom: 0; left: 0; right: 0; background: #fff; padding: 10px 12px; box-shadow: 0 -2px 8px rgba(0,0,0,.1); display: flex; gap: 10px; max-width: 640px; margin: 0 auto; }
  button { border: none; border-radius: 10px; padding: 13px 16px; font-size: 15px; font-weight: 700; flex: 1; cursor: pointer; }
  .btn-primary { background: #06c755; color: #fff; }
  .btn-primary:disabled { background: #b7e6c8; color: #fff; cursor: not-allowed; }
  .btn-secondary { background: #eee; color: #444; }
  .hint { text-align: center; font-size: 12px; color: #888; padding: 8px 12px 0; }
  .warn { display: none; background: #fff3cd; color: #7a5b00; padding: 10px 12px; border-radius: 10px; font-size: 13px; margin: 0 12px 10px; }
  .done-screen { text-align: center; padding: 60px 20px; }
  .done-screen .icon { font-size: 48px; }
  .done-screen p { font-size: 15px; color: #444; line-height: 1.6; }
`;

// ==========================================
// EVENT HANDLER
// ==========================================
function handleEvent(event) {
  const userId = event.source.userId;
  const userProperties = PropertiesService.getUserProperties();
  debugLog(`handleEvent: type=${event.type} messageType=${event.message ? event.message.type : '-'} userId=${userId}`);

  if (isResetCommand(event)) {
    clearAllUserProperties(userProperties, userId);
    sendSheetFlexMenu(event.replyToken);
    return;
  }

  if (isStopCommand(event)) {
    clearAllUserProperties(userProperties, userId);
    replyText(event.replyToken, '🛑 หยุดการใช้งานเรียบร้อยแล้ว\n\nหากต้องการกลับมาใช้งานใหม่ พิมพ์ "EXIT" หรือส่งสติ๊กเกอร์เข้ามาได้เลยครับ');
    return;
  }

  // 1. จัดการเมื่อผู้ใช้ส่งรูปภาพ
  if (event.type === 'message' && event.message.type === 'image') {
    const sheetId = userProperties.getProperty(userId + '_sheetId');
    const sheetName = userProperties.getProperty(userId + '_sheetName');
    const seq = userProperties.getProperty(userId + '_seq');
    debugLog(`image received. msgId=${event.message.id} sheetId=${sheetId} sheetName=${sheetName} seq=${seq}`);

    if (!sheetId || !seq) {
      debugLog('image rejected: missing sheetId or seq');
      replyText(event.replyToken, '⚠️ กรุณาเลือกแผ่นงาน Google Sheets และกำหนดเลข SEQ ก่อนส่งรูปภาพครับ');
      return;
    }

    let uploaded;
    try {
      uploaded = uploadImageToPendingDrive(event.message.id, seq, sheetName);
      debugLog(`upload success. fileId=${uploaded.fileId} imageUrl=${uploaded.imageUrl}`);
    } catch (err) {
      debugLog('Pending upload error: ' + err + ' stack=' + err.stack);
      replyText(event.replyToken, `❌ อัปโหลดรูปภาพไม่สำเร็จ: ${err.message}`);
      return;
    }

    // เก็บเข้าคิว pending ของ SEQ นี้ ไม่ส่ง Flex ทันที (กันเด้งรัวๆ ตอนส่งหลายรูปพร้อมกัน)
    // เจ้าหน้าที่กดปุ่ม "จัดการรูป" เองเมื่อพร้อมจะจำแนกทีละใบ
    const queue = getPendingQueue(userId, seq);
    queue.push({ fileId: uploaded.fileId, imageUrl: uploaded.imageUrl });
    savePendingQueue(userId, seq, queue);

    // ข้อ 4: LINE ส่งรูปแต่ละใบเป็นคนละ webhook call แยกกัน (แม้ผู้ใช้เลือกส่งพร้อมกันจากคลังภาพ)
    // จึงต้อง debounce ข้าม execution ด้วย CacheService: ทุกรูปที่เข้ามาจะแย่งจอง "ตั๋วล่าสุด" ของ burst นี้
    // แล้ว sleep รอสักครู่ — execution ที่ตั๋วยังไม่ถูกแย่งหลัง sleep เท่านั้นที่จะเป็นคนตอบกลับรวบยอด
    const cache = CacheService.getScriptCache();
    const burstKey = `imgBurst_${userId}_${seq}`;
    const burstCountKey = `imgBurstCount_${userId}_${seq}`;
    const myTicket = `${event.replyToken}|${Date.now()}|${Math.random()}`;
    cache.put(burstKey, myTicket, 30);
    const burstCountSoFar = (parseInt(cache.get(burstCountKey), 10) || 0) + 1;
    cache.put(burstCountKey, String(burstCountSoFar), 30);

    Utilities.sleep(IMAGE_BATCH_DEBOUNCE_MS);

    if (cache.get(burstKey) !== myTicket) {
      // มีรูปใหม่เข้ามาระหว่างรอ ปล่อยให้ execution ของรูปล่าสุดใน burst เป็นคนตอบกลับแทน ไม่ต้องทำอะไรต่อ
      return;
    }

    const finalQueue = getPendingQueue(userId, seq);
    const finalBurstCount = parseInt(cache.get(burstCountKey), 10) || 1;
    cache.remove(burstKey);
    cache.remove(burstCountKey);
    replyBatchAck(event.replyToken, seq, finalBurstCount, finalQueue.length);
    return;
  }

  // 2. จัดการการกดปุ่ม (Postback Event)
  if (event.type === 'postback') {
    const data = parseQueryString(event.postback.data);

    // เลือกแผ่นงาน Sheets
    if (data.action === 'select_sheet') {
      userProperties.setProperty(userId + '_sheetId', data.sheetId);
      userProperties.setProperty(userId + '_sheetName', data.sheetName);
      userProperties.deleteProperty(userId + '_seq');
      userProperties.setProperty(userId + '_awaitingSeq', 'true');
      const userNameForList = getLineUserProfile(userId);
      const bookedListText = formatBookedSeqListText(data.sheetId, userNameForList);
      replySeqPromptWithBookingOption(
        event.replyToken,
        `📊 คุณเลือกแผ่นงาน: "${data.sheetName}"\n\n${bookedListText}กรุณาพิมพ์หมายเลข SEQ ที่ต้องการจัดการ หรือกดปุ่ม "จอง SEQ" ด้านล่าง:`
      );
      return;
    }

    // เริ่ม/ทำต่อ การจัดการรูปในคิว pending ทั้งหมด (เปิดหน้า popup — ข้อ 5)
    if (data.action === 'manage_photos') {
      handleManagePhotos(event, userId);
      return;
    }

    // จบงาน / สรุปข้อมูล
    if (data.action === 'finish_case') {
      showSummaryAndNameOptions(event, userId);
      return;
    }

    // ยืนยันการเลือกชื่อ
    if (data.action === 'confirm_name_selection') {
      saveFinalNameAndComplete(event, userId, data.choice);
      return;
    }

    // นำเข้าผลลัพธ์ OCR ที่ประมวลผลเสร็จแล้วจากแท็บ OCR_RESULTS
    if (data.action === 'import_ocr') {
      importOcrResult(event, userId, data.seq);
      return;
    }

    // Quick Reply Menu Actions หลังจบงาน
    if (data.action === 'menu_select_seq') {
      const sheetIdForSelect = userProperties.getProperty(userId + '_sheetId');
      userProperties.setProperty(userId + '_awaitingSeq', 'true');
      const userNameForList = getLineUserProfile(userId);
      const bookedListText = formatBookedSeqListText(sheetIdForSelect, userNameForList);
      replyText(event.replyToken, `${bookedListText}📸 กรุณากรอกเลข SEQ สำหรับเคสถัดไป (เช่น 02 หรือ 105):`);
      return;
    }

    if (data.action === 'menu_reserve_seq' || data.action === 'book_seq') {
      userProperties.setProperty(userId + '_awaitingBookingCount', 'true');
      userProperties.deleteProperty(userId + '_awaitingSeq');
      replyText(event.replyToken, '📌 ต้องการจอง SEQ กี่คนครับ? (กรุณากรอกตัวเลข เช่น 1, 2, 3)');
      return;
    }

    if (data.action === 'menu_end') {
      clearAllUserProperties(userProperties, userId);
      replyText(event.replyToken, "🏁 ปิดการทำงานเรียบร้อยแล้ว หากต้องการเริ่มใหม่ สามารถกดเลือกเมนูหรือพิมพ์ EXIT ได้เลยครับ");
      return;
    }

    // ปุ่ม "เพิ่มรูป" ในเมนูรวม (ข้อ 2) — แค่เตือนให้ส่งรูปเข้ามาในแชท ไม่มี action พิเศษ
    if (data.action === 'prompt_add_photo') {
      const seqForPrompt = userProperties.getProperty(userId + '_seq');
      if (!seqForPrompt) {
        replyText(event.replyToken, '⚠️ ยังไม่ได้กำหนด SEQ ครับ กรุณาพิมพ์หมายเลข SEQ ก่อน');
        return;
      }
      sendLineReply(event.replyToken, [{
        type: 'text',
        text: `📷 ส่งรูปภาพสำหรับ SEQ ${seqForPrompt} เข้ามาในแชทได้เลยครับ (ส่งได้หลายรูปพร้อมกัน)`,
        quickReply: { items: buildSeqActionQuickReplyItems(seqForPrompt) }
      }]);
      return;
    }

    // ปุ่ม "📝 ข้อมูลเพิ่มเติม" ในเมนูรวม (ข้อ 6) — เปิดหน้า popup กรอกข้อมูลเสริมให้ SUMMARY
    if (data.action === 'extra_info_form') {
      const sheetIdForExtra = userProperties.getProperty(userId + '_sheetId');
      const sheetNameForExtra = userProperties.getProperty(userId + '_sheetName');
      const seqForExtra = userProperties.getProperty(userId + '_seq');
      if (!sheetIdForExtra || !seqForExtra) {
        replyText(event.replyToken, '⚠️ ยังไม่ได้กำหนด SEQ ครับ กรุณาพิมพ์หมายเลข SEQ ก่อน');
        return;
      }
      const extraInfoUrl = buildPopupUrl('extra_info', { sheetId: sheetIdForExtra, sheetName: sheetNameForExtra, seq: seqForExtra, uid: userId });
      sendLineReply(event.replyToken, [{
        type: 'template',
        altText: `SEQ ${seqForExtra} — กรอกข้อมูลเพิ่มเติม`,
        template: {
          type: 'buttons',
          text: `📝 กรอกข้อมูลเพิ่มเติมสำหรับ SEQ ${seqForExtra}`,
          actions: [
            { type: 'uri', label: '📝 ข้อมูลเพิ่มเติม', uri: extraInfoUrl }
          ]
        },
        quickReply: { items: buildSeqActionQuickReplyItems(seqForExtra) }
      }]);
      return;
    }
  }

  // 3. จัดการเมื่อผู้ใช้ส่งข้อความ (Text Event)
  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim();
    const currentSheetId = userProperties.getProperty(userId + '_sheetId');

    if (!currentSheetId) {
      sendSheetFlexMenu(event.replyToken);
      return;
    }

    // อยู่ในขั้นตอนกรอกจำนวนคนจอง SEQ
    const awaitingBookingCount = userProperties.getProperty(userId + '_awaitingBookingCount') === 'true';
    if (awaitingBookingCount) {
      const count = parseInt(text, 10);
      if (isNaN(count) || count <= 0) {
        replyText(event.replyToken, '⚠️ กรุณากรอกจำนวนเป็นตัวเลขมากกว่า 0 ครับ (เช่น 1, 2, 3)');
        return;
      }
      try {
        const userName = getLineUserProfile(userId);
        const bookedSeqs = processBookingInSummarySheet(currentSheetId, count, userName);
        addBookedSeqs(currentSheetId, userName, bookedSeqs);
        userProperties.deleteProperty(userId + '_awaitingBookingCount');
        userProperties.setProperty(userId + '_pendingFlightSeqs', JSON.stringify(bookedSeqs));
        replyText(
          event.replyToken,
          `✅ **รับยอดจอง SEQ เรียบร้อยแล้ว!**\n• ผู้จอง: ${userName}\n• จำนวน: ${count} คน\n• ได้รับ SEQ: ${bookedSeqs.join(', ')}\n\n✈️ กรุณากรอก Flight No. สำหรับการเดินทางกลุ่มนี้:`
        );
      } catch (err) {
        debugLog('Booking Error: ' + err);
        replyText(event.replyToken, `❌ ${err.message || 'เกิดข้อผิดพลาดในการจอง SEQ'}`);
      }
      return;
    }

    // อยู่ในขั้นตอนกรอก Flight No.
    const pendingFlightSeqsStr = userProperties.getProperty(userId + '_pendingFlightSeqs');
    if (pendingFlightSeqsStr) {
      const formattedFlightNo = formatFlightNo(text);
      try {
        const bookedSeqs = JSON.parse(pendingFlightSeqsStr);
        updateFlightNoInSummarySheet(currentSheetId, bookedSeqs, formattedFlightNo);
        userProperties.deleteProperty(userId + '_pendingFlightSeqs');
        userProperties.setProperty(userId + '_awaitingSeq', 'true');
        const seqListStr = bookedSeqs.map(s => `• SEQ ${s}`).join('\n');
        const userNameForList = getLineUserProfile(userId);
        const bookedListText = formatBookedSeqListText(currentSheetId, userNameForList);
        replySeqPromptWithBookingOption(
          event.replyToken,
          `🎉 **สรุปการจองสำเร็จ!**\n\n✈️ **Flight No.:** ${formattedFlightNo}\n📋 **รายการ SEQ ที่จอง (${bookedSeqs.length} คน):**\n${seqListStr}\n\n---------------------------\n${bookedListText}กรุณาพิมพ์หมายเลข SEQ ที่ต้องการถ่ายรูปจัดการต่อได้เลยครับ:`
        );
      } catch (err) {
        debugLog('Save Flight Error: ' + err);
        replyText(event.replyToken, `❌ เกิดข้อผิดพลาดในการบันทึก Flight No.: ${err.message}`);
      }
      return;
    }

    // อยู่ในขั้นตอนรอรับหมายเลข SEQ
    const awaitingSeq = userProperties.getProperty(userId + '_awaitingSeq') === 'true';
    if (awaitingSeq) {
      if (!/^\d+$/.test(text) || parseInt(text, 10) <= 0) {
        replyText(event.replyToken, `⚠️ หมายเลข SEQ ต้องเป็นตัวเลขจำนวนเต็มมากกว่า 0 เท่านั้นครับ (เช่น 2 หรือ 105)\nกรุณาพิมพ์หมายเลข SEQ ใหม่อีกครั้ง:`);
        return;
      }
      userProperties.setProperty(userId + '_seq', text);
      userProperties.deleteProperty(userId + '_awaitingSeq');
      sendLineReply(event.replyToken, [{
        type: 'text',
        text: `📸 กำหนด SEQ: [ ${text} ] เรียบร้อยแล้ว\n\nคุณสามารถส่งรูปภาพเข้ามาได้เลย หรือเลือกทำรายการด้านล่าง:`,
        quickReply: { items: buildSeqActionQuickReplyItems(text) }
      }]);
      return;
    }

    replyChangeSeqPrompt(event.replyToken, `❓ ไม่เข้าใจข้อความ "${text}" ครับ\nหากต้องการเปลี่ยนหรือจบ SEQ ปัจจุบัน กดปุ่มด้านล่างได้เลย หรือพิมพ์ "EXIT" เพื่อเลือกแผ่นงานใหม่ / พิมพ์ "STOP" เพื่อหยุดทำงาน`);
  }
}

// ==========================================
// 📸 Image Handling & Classification (ข้อ 5 — popup HTML แทน Flex ทีละใบ)
// ==========================================

// ชื่อไฟล์ที่ใช้แสดงผลสำหรับแต่ละประเภทเอกสาร (photoType ภายในระบบ -> label ชื่อไฟล์)
const PHOTO_TYPE_FILE_LABELS = {
  'PASSPORT': 'PASSPORT',
  'Return Ticket': 'TICKET',
  'Accomodation': 'ACCOMMODATION',
  'ETC': 'ETC'
};

// ตัวเลือกประเภทเอกสารที่โชว์ในหน้า popup จัดการรูป (value ต้องตรงกับคีย์ของ PHOTO_TYPE_FILE_LABELS)
const PHOTO_TYPE_OPTIONS = [
  { value: 'PASSPORT', label: 'PASSPORT' },
  { value: 'Return Ticket', label: 'RETURN TICKET' },
  { value: 'Accomodation', label: 'ACCOMMODATION' },
  { value: 'ETC', label: 'ETC' }
];

// อัปโหลดรูปที่เพิ่งได้รับขึ้น Drive ทันที (ตั้งชื่อชั่วคราว) เพื่อเอา URL มาโชว์พรีวิวในหน้า popup
function uploadImageToPendingDrive(msgId, seq, sheetName) {
  debugLog(`uploadImageToPendingDrive: msgId=${msgId} seq=${seq} sheetName=${sheetName}`);
  const folder = getOrCreatePhotoFolder(MAIN_FOLDER_NAME, sheetName);
  debugLog(`folder resolved: ${folder.getName()} (${folder.getId()})`);
  const imageBlob = getImageBlobFromLine(msgId);
  debugLog(`image blob fetched from LINE. size=${imageBlob.getBytes().length} contentType=${imageBlob.getContentType()}`);
  imageBlob.setName(`${seq}_PENDING_${msgId}.jpg`);

  const file = folder.createFile(imageBlob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  const imageUrl = `https://drive.google.com/thumbnail?id=${file.getId()}&sz=w1000`;
  debugLog(`drive file created: ${file.getId()} url=${imageUrl}`);

  return { fileId: file.getId(), imageUrl: imageUrl };
}

// ==========================================
// คิวรูป Pending ต่อ SEQ (สำหรับ flow "จัดการรูป" ทีละใบ)
// ==========================================
function getPendingQueue(userId, seq) {
  const raw = PropertiesService.getUserProperties().getProperty(`${userId}_pendingQueue_${seq}`);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch (e) {
    return [];
  }
}

function savePendingQueue(userId, seq, queue) {
  const userProperties = PropertiesService.getUserProperties();
  const key = `${userId}_pendingQueue_${seq}`;
  if (queue.length === 0) {
    userProperties.deleteProperty(key);
  } else {
    userProperties.setProperty(key, JSON.stringify(queue));
  }
}

function removeFromPendingQueue(userId, seq, fileId) {
  const queue = getPendingQueue(userId, seq).filter(item => item.fileId !== fileId);
  savePendingQueue(userId, seq, queue);
  return queue;
}

// ล้างคิว/ตัวนับ pending ของ SEQ หนึ่งๆ ทิ้งทั้งหมด (เรียกตอนกด "จบงาน" สำเร็จ - ข้อ 3.7)
function clearPendingQueueState(userId, seq) {
  if (!seq) return;
  const userProperties = PropertiesService.getUserProperties();
  userProperties.deleteProperty(`${userId}_pendingQueue_${seq}`);
  userProperties.deleteProperty(`${userId}_manageTotal_${seq}`);
}

// เมนู quick reply มาตรฐานหลัง SEQ ถูกกำหนด/สลับ (ข้อ 2) — ใช้ซ้ำได้ทุกจุดที่ SEQ พร้อมใช้งาน
function buildSeqActionQuickReplyItems(seq) {
  return [
    { type: 'action', action: { type: 'postback', label: '📷 เพิ่มรูป', data: 'action=prompt_add_photo', displayText: 'เพิ่มรูป' } },
    { type: 'action', action: { type: 'postback', label: '🗂️ จัดการรูปภาพ', data: 'action=manage_photos', displayText: 'จัดการรูปภาพ' } },
    { type: 'action', action: { type: 'postback', label: '📥 นำเข้าข้อมูล', data: `action=import_ocr&seq=${seq}`, displayText: 'นำเข้าข้อมูล' } },
    { type: 'action', action: { type: 'postback', label: '📝 ข้อมูลเพิ่มเติม', data: 'action=extra_info_form', displayText: 'ข้อมูลเพิ่มเติม' } },
    { type: 'action', action: { type: 'postback', label: '🏁 จบงาน', data: 'action=finish_case', displayText: 'จบงาน' } },
    { type: 'action', action: { type: 'postback', label: '📌 จอง SEQ', data: 'action=book_seq', displayText: 'จองSEQ' } },
    { type: 'action', action: { type: 'postback', label: '🔢 เลือก SEQ', data: 'action=menu_select_seq', displayText: 'เลือกSEQ' } }
  ];
}

// ข้อ 2 (ข้อย่อย 3): กด "นำเข้าข้อมูล" ตอนยังไม่มีผล OCR พร้อม — ให้ quick reply ทางลัด [เพิ่มรูป, เลือก SEQ, จอง SEQ] แทน
function replyNoOcrDataYet(replyToken, seq, text) {
  const message = {
    type: 'text',
    text,
    quickReply: {
      items: [
        { type: 'action', action: { type: 'postback', label: '📷 เพิ่มรูป', data: 'action=prompt_add_photo', displayText: 'เพิ่มรูป' } },
        { type: 'action', action: { type: 'postback', label: '🔢 เลือก SEQ', data: 'action=menu_select_seq', displayText: 'เลือกSEQ' } },
        { type: 'action', action: { type: 'postback', label: '📌 จอง SEQ', data: 'action=book_seq', displayText: 'จองSEQ' } }
      ]
    }
  };
  sendLineReply(replyToken, [message]);
}

// ข้อความตอบกลับทันทีที่รับรูป (แทนการเด้ง Flex ทันที) พร้อม Quick Reply ให้กดจัดการรูปเมื่อพร้อม
// n = จำนวนรูปที่ส่งเข้ามาในรอบ (burst) นี้, total = จำนวนรูปสะสมทั้งหมดที่รอจัดการของ SEQ นี้ (ข้อ 4)
function replyBatchAck(replyToken, seq, n, total) {
  const message = {
    type: 'text',
    text: `📸 SEQ: ${seq} รับรูปทั้งหมด ${n}/${total} รูปเรียบร้อยแล้ว\n\nต้องการทำอะไรต่อดีครับ?`,
    quickReply: { items: buildSeqActionQuickReplyItems(seq) }
  };
  sendLineReply(replyToken, [message]);
}

// ปุ่ม "🗂️ จัดการรูปภาพ" — ส่งลิงก์เปิดหน้า popup (ข้อ 5) แสดงรูปทั้งหมดในคิว pending ของ SEQ นี้พร้อมกัน
function handleManagePhotos(event, userId) {
  const userProperties = PropertiesService.getUserProperties();
  const seq = userProperties.getProperty(userId + '_seq');
  if (!seq) {
    replyText(event.replyToken, '⚠️ ยังไม่ได้กำหนด SEQ ครับ กรุณาพิมพ์หมายเลข SEQ ก่อน');
    return;
  }

  const queue = getPendingQueue(userId, seq);
  if (queue.length === 0) {
    replyText(event.replyToken, `ℹ️ SEQ ${seq} ไม่มีรูปที่รอจัดการอยู่ในคิวครับ`);
    return;
  }

  const sheetId = userProperties.getProperty(userId + '_sheetId');
  const sheetName = userProperties.getProperty(userId + '_sheetName');
  const url = buildPopupUrl('manage_photos', { sheetId, sheetName, seq, uid: userId });

  sendLineReply(event.replyToken, [{
    type: 'template',
    altText: `SEQ ${seq} มีรูปรอจัดการ ${queue.length} รูป — กดเปิดหน้าจัดการรูปภาพ`,
    template: {
      type: 'buttons',
      text: `🗂️ SEQ ${seq} มีรูปรอจัดการ ${queue.length} รูป`,
      actions: [
        { type: 'uri', label: '🗂️ จัดการรูปภาพ', uri: url }
      ]
    },
    quickReply: { items: buildSeqActionQuickReplyItems(seq) }
  }]);
}

// บันทึกรูป 1 ใบตามประเภทที่เลือก (ย้ายไฟล์ Drive + เขียนแท็บ PHOTO + ส่ง OCR ถ้าเป็น PASSPORT)
// เป็นฟังก์ชัน "บริสุทธิ์" ไม่ผูกกับ LINE event/replyToken เพราะเรียกจากหน้า popup (doPost) ซึ่งไม่มี replyToken ให้ตอบกลับตรงๆ
function classifyAndSavePhoto(sheetId, sheetName, seq, fileId, photoType) {
  try {
    const targetRow = findSeqRowInSheet(sheetId, seq);
    if (targetRow === -1) {
      return { ok: false, photoType, error: `ไม่พบหมายเลข SEQ "${seq}" ในคอลัมน์ A ของแท็บ PHOTO` };
    }

    const folder = getOrCreatePhotoFolder(MAIN_FOLDER_NAME, sheetName);
    const file = DriveApp.getFileById(fileId);
    const imageUrl = `https://drive.google.com/thumbnail?id=${file.getId()}&sz=w1000`;

    let fileName;
    if (photoType === 'ETC') {
      // ครอบด้วย lock: หาคอลัมน์ว่าง + เขียนสูตรรูปลงชีต ต้องเป็น atomic กันรูป ETC หลายใบชนคอลัมน์กัน (ข้อ 8.3)
      const etcCol = withLock(() => {
        const col = getNextEtcColumn(sheetId, targetRow);
        saveImageUrlToSheetRow(sheetId, targetRow, 'ETC', imageUrl, col);
        return col;
      });
      const etcIndex = etcCol - 6; // col 7 -> ETC_1, col 8 -> ETC_2, ...
      fileName = `${seq}_ETC_${sheetName}_${etcIndex}.jpg`;
      file.setName(fileName);
    } else {
      fileName = `${seq}_${PHOTO_TYPE_FILE_LABELS[photoType]}_${sheetName}.jpg`;
      deleteExistingDriveFile(folder, fileName);
      file.setName(fileName);
      saveImageUrlToSheetRow(sheetId, targetRow, photoType, imageUrl, null);
    }

    let ocrQueued = false;
    let ocrError = '';
    if (photoType === 'PASSPORT') {
      const queued = submitPassportOcrAsync(sheetId, seq, file.getBlob());
      if (queued) {
        recordOcrQueued(sheetId, seq);
        ocrQueued = true;
      } else {
        ocrError = 'บันทึกรูป [Passport] แล้ว แต่ส่งไปประมวลผล OCR ไม่สำเร็จ ลองเปลี่ยน SEQ นี้ใหม่แล้วถ่ายซ้ำได้เลยครับ (ถ่ายซ้ำจะ overwrite ทับไฟล์เดิมเสมอ)';
      }
    }

    return { ok: true, photoType, ocrQueued, ocrError };
  } catch (err) {
    return { ok: false, photoType, error: err.message };
  }
}

// เมนู quick reply มาตรฐานหลังปิดหน้า popup จัดการรูป (ข้อ 5)
function popupFollowUpQuickReplyItems() {
  return [
    { type: 'action', action: { type: 'postback', label: '📌 จอง SEQ', data: 'action=book_seq', displayText: 'จองSEQ' } },
    { type: 'action', action: { type: 'postback', label: '🔢 เลือก SEQ', data: 'action=menu_select_seq', displayText: 'เลือกSEQ' } },
    { type: 'action', action: { type: 'postback', label: '🏁 สิ้นสุดแผ่นงาน', data: 'action=menu_end', displayText: 'สิ้นสุดแผ่นงาน' } }
  ];
}

// เรียกจาก doPost เมื่อหน้า popup กด "เสร็จสิ้น" — บันทึกทุกรูปที่เลือกประเภทแล้วรวดเดียว แล้ว push ข้อความสรุปกลับไป
function handleSavePhotoClassification(e, body) {
  try {
    const sheetId = e.parameter.sheetId;
    const sheetName = e.parameter.sheetName || '';
    const seq = e.parameter.seq;
    const uid = e.parameter.uid;
    const classifications = (body && body.classifications) || [];

    if (!sheetId || !seq || !uid || classifications.length === 0) {
      return jsonResponse({ success: false, error: 'พารามิเตอร์ไม่ครบ' });
    }

    let savedCount = 0;
    const noteLines = [];
    for (const item of classifications) {
      const result = classifyAndSavePhoto(sheetId, sheetName, seq, item.fileId, item.photoType);
      if (result.ok) {
        removeFromPendingQueue(uid, seq, item.fileId);
        savedCount++;
        if (result.ocrError) noteLines.push(`⚠️ ${result.ocrError}`);
      } else {
        noteLines.push(`❌ [${item.photoType}] ${result.error}`);
      }
    }

    PropertiesService.getUserProperties().deleteProperty(uid + '_manageTotal_' + seq);

    const total = classifications.length;
    const noteText = noteLines.length > 0 ? `\n\n${noteLines.join('\n')}` : '';
    pushMessages(uid, [{
      type: 'text',
      text: `🎉 จัดการรูปภาพเสร็จสิ้น ${savedCount}/${total} รูป${noteText}\n\nกรุณาเลือกสิ่งที่จะทำถัดไป:`,
      quickReply: { items: popupFollowUpQuickReplyItems() }
    }]);

    return jsonResponse({ success: true, savedCount, total });
  } catch (err) {
    debugLog('handleSavePhotoClassification error: ' + err);
    return jsonResponse({ success: false, error: err.message });
  }
}

// เรียกจาก doPost เมื่อหน้า popup กด "ทำภายหลัง" — ไม่บันทึกอะไร คิวเดิมค้างไว้ครบ แค่แจ้งเตือนแล้วปิด
function handleDeferPhotoClassification(e) {
  try {
    const seq = e.parameter.seq;
    const uid = e.parameter.uid;
    const remaining = getPendingQueue(uid, seq).length;

    pushMessages(uid, [{
      type: 'text',
      text: `📋 ยังมีรูปค้างจัดการอยู่ ${remaining} รูปสำหรับ SEQ ${seq} ครับ กดปุ่ม "จัดการรูปภาพ" เพื่อจัดการต่อได้ทีหลัง\n\nกรุณาเลือกสิ่งที่จะทำถัดไป:`,
      quickReply: { items: popupFollowUpQuickReplyItems() }
    }]);

    return jsonResponse({ success: true });
  } catch (err) {
    debugLog('handleDeferPhotoClassification error: ' + err);
    return jsonResponse({ success: false, error: err.message });
  }
}

// เสิร์ฟหน้า popup จัดการรูปภาพ (ข้อ 5) — แสดงรูปทั้งหมดในคิว pending ของ SEQ นี้พร้อมกัน
function renderManagePhotosPage(e) {
  const sheetId = e.parameter.sheetId;
  const sheetName = e.parameter.sheetName || '';
  const seq = e.parameter.seq;
  const uid = e.parameter.uid;
  const queue = getPendingQueue(uid, seq);
  // Apps Script Web App เด้ง (redirect) ไปโหลด HTML จริงจากโดเมน script.googleusercontent.com เสมอ
  // ทำให้ window.location.href ในเบราว์เซอร์ "ไม่ใช่" URL /exec ที่ doPost รับฟังอยู่ — ห้าม fetch กลับไปที่ location.href ตรงๆ
  // ต้องประกอบ URL /exec ที่แท้จริงขึ้นมาเองฝั่งเซิร์ฟเวอร์แล้วฝังเป็นค่าคงที่ลงในหน้า
  const apiUrl = buildPopupUrl('manage_photos', { sheetId, sheetName, seq, uid });

  const rowsHtml = queue.map((item, idx) => {
    const optionsHtml = PHOTO_TYPE_OPTIONS.map(opt => `
      <label class="type-opt">
        <input type="radio" name="type_${idx}" value="${escapeHtml(opt.value)}">
        <span>${escapeHtml(opt.label)}</span>
      </label>`).join('');
    return `
      <div class="card photo-row" data-file-id="${escapeHtml(item.fileId)}">
        <div class="photo-row-inner">
          <img src="${escapeHtml(item.imageUrl)}" alt="รูปที่ ${idx + 1}">
          <div class="type-opts">${optionsHtml}</div>
        </div>
      </div>`;
  }).join('');

  const html = `
    <style>
      ${POPUP_SHARED_STYLE}
      .photo-row-inner { display: flex; gap: 10px; padding: 10px; align-items: stretch; }
      .photo-row-inner img { width: 96px; height: 96px; object-fit: cover; border-radius: 10px; background: #eee; flex-shrink: 0; }
      .type-opts { flex: 1; display: grid; grid-template-columns: 1fr 1fr; gap: 6px; align-content: center; }
      .type-opt { display: flex; align-items: center; gap: 6px; font-size: 12px; background: #f4f5f7; border-radius: 8px; padding: 8px 6px; }
      .type-opt input { width: 16px; height: 16px; accent-color: #06c755; }
      .photo-row.selected .photo-row-inner { box-shadow: inset 0 0 0 2px #06c755; border-radius: 14px; }
    </style>
    <header>
      🗂️ จัดการรูปภาพ
      <small>SEQ ${escapeHtml(seq)} • ${escapeHtml(sheetName)} • ${queue.length} รูป</small>
    </header>
    <div class="container" id="listView">
      ${rowsHtml || '<p style="text-align:center;color:#888;padding:40px 0;">ไม่มีรูปที่รอจัดการแล้วครับ</p>'}
    </div>
    <div class="warn" id="warn">⚠️ กรุณาเลือกประเภทเอกสารให้ครบทุกรูปก่อนกด "เสร็จสิ้น" ครับ (หรือกด "ทำภายหลัง" ถ้ายังไม่พร้อม)</div>
    <div class="done-screen" id="doneView" style="display:none;"></div>
    <div class="footer-bar" id="footerBar">
      <button class="btn-secondary" id="btnDefer">⏳ ทำภายหลัง</button>
      <button class="btn-primary" id="btnFinish">✅ เสร็จสิ้น</button>
    </div>
    <script>
      var BASE_URL = ${JSON.stringify(apiUrl)};

      document.querySelectorAll('.photo-row input[type=radio]').forEach(function (input) {
        input.addEventListener('change', function () {
          input.closest('.photo-row').classList.add('selected');
        });
      });

      function setBusy(busy) {
        document.getElementById('btnFinish').disabled = busy;
        document.getElementById('btnDefer').disabled = busy;
      }

      function showDone(message) {
        document.getElementById('listView').style.display = 'none';
        document.getElementById('footerBar').style.display = 'none';
        document.getElementById('warn').style.display = 'none';
        var doneView = document.getElementById('doneView');
        doneView.style.display = 'block';
        doneView.innerHTML = '<div class="icon">✅</div><p>' + message + '</p><p style="color:#999;font-size:13px;">กดปุ่มปิด (✕) มุมขวาบนเพื่อกลับไปที่แชทได้เลยครับ</p>';
      }

      function showError(err) {
        setBusy(false);
        alert('เกิดข้อผิดพลาด: ' + (err && err.message ? err.message : err));
      }

      document.getElementById('btnFinish').addEventListener('click', function () {
        var rows = document.querySelectorAll('.photo-row');
        var classifications = [];
        var allSelected = true;
        rows.forEach(function (row) {
          var checked = row.querySelector('input[type=radio]:checked');
          if (!checked) { allSelected = false; return; }
          classifications.push({ fileId: row.dataset.fileId, photoType: checked.value });
        });
        if (rows.length === 0) { showDone('ไม่มีรูปที่ต้องจัดการแล้วครับ'); return; }
        if (!allSelected) { document.getElementById('warn').style.display = 'block'; return; }

        setBusy(true);
        fetch(BASE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ action: 'save_photo_classification', classifications: classifications })
        }).then(function (r) { return r.json(); }).then(function (res) {
          if (!res.success) throw new Error(res.error || 'บันทึกไม่สำเร็จ');
          showDone('จัดการรูปภาพเสร็จสิ้น ' + res.savedCount + '/' + res.total + ' รูปเรียบร้อยแล้ว');
        }).catch(showError);
      });

      document.getElementById('btnDefer').addEventListener('click', function () {
        setBusy(true);
        fetch(BASE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ action: 'defer_photo_classification' })
        }).then(function (r) { return r.json(); }).then(function (res) {
          if (!res.success) throw new Error(res.error || 'เกิดข้อผิดพลาด');
          showDone('ปิดหน้าจัดการรูปภาพแล้ว รูปที่ยังไม่ได้เลือกประเภทจะค้างในคิวไว้ให้จัดการทีหลังครับ');
        }).catch(showError);
      });
    </script>`;

  return HtmlService.createHtmlOutput(html)
    .setTitle('จัดการรูปภาพ — SEQ ' + seq)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ==========================================
// 🔍 OCR (แบบ Background) & SUMMARY TAB LOGIC
// ==========================================

// ส่งรูป Passport ไปประมวลผล OCR แบบ background ที่ app.py (ไม่รอผลลัพธ์)
function submitPassportOcrAsync(sheetId, seq, imageBlob) {
  try {
    const boundary = "---------------------------" + new Date().getTime().toString(16);
    const filename = imageBlob.getName() || "passport.jpg";
    const contentType = imageBlob.getContentType() || "image/jpeg";
    const bytes = imageBlob.getBytes();

    const seqField = `--${boundary}\r\nContent-Disposition: form-data; name="seq"\r\n\r\n${seq}\r\n`;
    const sheetIdField = `--${boundary}\r\nContent-Disposition: form-data; name="sheetId"\r\n\r\n${sheetId}\r\n`;
    const imageHeader = `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;

    const seqFieldBytes = Utilities.newBlob(seqField).getBytes();
    const sheetIdFieldBytes = Utilities.newBlob(sheetIdField).getBytes();
    const imageHeaderBytes = Utilities.newBlob(imageHeader).getBytes();
    const footerBytes = Utilities.newBlob(footer).getBytes();

    // ต่อไบต์อาเรย์ตรงๆ ทุกส่วน ไม่ผ่าน base64 เลย (กันปัญหา padding แทรกกลางแบบที่เคยเจอ)
    const payload = seqFieldBytes.concat(sheetIdFieldBytes).concat(imageHeaderBytes).concat(bytes).concat(footerBytes);

    const options = {
      method: "post",
      contentType: "multipart/form-data; boundary=" + boundary,
      payload: payload,
      muteHttpExceptions: true
    };

    const response = UrlFetchApp.fetch(RENDER_OCR_SUBMIT_URL, options);
    const code = response.getResponseCode();
    return code === 202 || code === 200;
  } catch (err) {
    debugLog("submitPassportOcrAsync Exception: " + err.toString());
    return false;
  }
}

// ข้อความแจ้งว่าส่ง OCR ไปประมวลผลแล้ว (ไม่มี quickReply ในตัวเอง — ปุ่มนำเข้าข้อมูลจะถูกแปะรวมกับข้อความสุดท้ายของชุด reply แทน
// เพราะ LINE แสดง quickReply ของข้อความสุดท้ายเท่านั้นเมื่อส่งหลายข้อความพร้อมกัน)
function buildOcrQueuedMessage(seq) {
  return {
    type: 'text',
    text: `📤 ส่งรูป Passport (SEQ ${seq}) ไปประมวลผล OCR แล้ว\nระบบใช้เวลาสักครู่ กดปุ่ม "นำเข้าข้อมูล" ด้านล่างสุดเมื่อพร้อมดึงผลลัพธ์`
  };
}

// เรียกจาก doPost เมื่อ app.py ประมวลผล OCR เสร็จและยิง callback กลับมา
// เขียนแถว "queued" ลง OCR_RESULTS ทันทีที่ส่งรูป Passport ไป OCR สำเร็จ (ก่อน callback จะมาจริง)
// เพื่อบันทึกเวลาที่ส่งไว้เทียบ timeout 1 นาทีตอนกด "นำเข้าข้อมูล" (ข้อ 4.2)
// ครอบด้วย lock เพราะเขียนแถวเดียวกับที่ handleOcrCallback อาจเขียนพร้อมกันได้ (ข้อ 8.2)
function recordOcrQueued(sheetId, seq) {
  withLock(() => {
    const ocrSheet = getOrCreateOcrResultsSheet(sheetId);
    let rowIndex = findRowBySeqCached(sheetId, 'OCR_RESULTS', seq);
    if (rowIndex === -1) {
      rowIndex = ocrSheet.getLastRow() + 1;
      invalidateSeqRowCache(sheetId, 'OCR_RESULTS');
    }
    const timestamp = Utilities.formatDate(new Date(), "GMT+7", "dd/MM/yyyy HH:mm:ss");
    const rowValues = [seq, timestamp, 'queued', '', '', '', '', '', '', 'pending', Date.now()];
    const targetRange = ocrSheet.getRange(rowIndex, 1, 1, 11);
    targetRange.setValues([rowValues]);
    targetRange.setFontLine('none');
  });
}

// ครอบด้วย lock เพราะ Callback จาก Render หลาย SEQ อาจเข้ามาพร้อมกัน เสี่ยงเขียนทับแถวกันเอง (ข้อ 8.2)
function handleOcrCallback(payload) {
  const seq = payload.seq;
  const sheetId = payload.sheetId;
  if (!seq || !sheetId) {
    debugLog('ocr_callback missing seq/sheetId: ' + JSON.stringify(payload));
    return;
  }

  withLock(() => {
    const ocrSheet = getOrCreateOcrResultsSheet(sheetId);
    let rowIndex = findRowBySeqCached(sheetId, 'OCR_RESULTS', seq);
    if (rowIndex === -1) {
      rowIndex = ocrSheet.getLastRow() + 1;
      invalidateSeqRowCache(sheetId, 'OCR_RESULTS');
    }

    const timestamp = Utilities.formatDate(new Date(), "GMT+7", "dd/MM/yyyy HH:mm:ss");
    let rowValues;

    if (payload.success && payload.data) {
      const d = payload.data;
      const passportNo = d.passport_number ? String(d.passport_number).replace(/[^A-Za-z0-9]/g, '').toUpperCase().trim() : '';
      rowValues = [
        seq, timestamp, 'done',
        d.nationality || '', passportNo, d.sex || '',
        d.regex_full_name || '', d.passporteye_full_name || '',
        d.remark || '', 'pending', ''
      ];
    } else {
      rowValues = [
        seq, timestamp, 'error', '', '', '', '', '',
        payload.error || 'OCR failed', 'pending', ''
      ];
    }

    const targetRange = ocrSheet.getRange(rowIndex, 1, 1, 11);
    targetRange.setValues([rowValues]);
    // ล้างขีดฆ่าเดิม เผื่อแถวนี้เคยถูก import ไปแล้วก่อนหน้า (กรณีถ่ายซ้ำ/SEQ ซ้ำ ให้ overwrite ทับ)
    targetRange.setFontLine('none');
  });
}

function getOrCreateOcrResultsSheet(sheetId) {
  const ss = SpreadsheetApp.openById(sheetId);
  let sheet = ss.getSheetByName('OCR_RESULTS');
  if (!sheet) {
    sheet = ss.insertSheet('OCR_RESULTS');
    const headers = ['SEQ', 'Timestamp', 'Status', 'Nationality', 'PassportNo', 'Sex', 'RegexName', 'PassportEyeName', 'Remark', 'ImportStatus', 'QueuedAtMs'];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }
  return sheet;
}

// ==========================================
// CACHED SEQ -> ROW INDEX (ข้อ 5.3 — เร่งความเร็วการค้นหาแถวใน SUMMARY/OCR_RESULTS)
// ==========================================
const OCR_TIMEOUT_MS = 60 * 1000; // 1 นาที (ข้อ 4.2)

function buildSeqRowMap(sheetId, tabName) {
  const ss = SpreadsheetApp.openById(sheetId);
  const sheet = ss.getSheetByName(tabName);
  if (!sheet) return {};
  const data = sheet.getDataRange().getValues();
  const map = {};
  for (let i = 1; i < data.length; i++) {
    const seq = String(data[i][0]).trim();
    if (seq) map[seq] = i + 1;
  }
  return map;
}

function findRowBySeqCached(sheetId, tabName, seq) {
  const cache = CacheService.getScriptCache();
  const cacheKey = `rowidx_${sheetId}_${tabName}`;
  let map = null;
  const cached = cache.get(cacheKey);
  if (cached) {
    try { map = JSON.parse(cached); } catch (e) { map = null; }
  }
  if (!map) {
    map = buildSeqRowMap(sheetId, tabName);
    cache.put(cacheKey, JSON.stringify(map), 300); // แคช 5 นาที
  }
  const row = map[String(seq).trim()];
  return row || -1;
}

function invalidateSeqRowCache(sheetId, tabName) {
  CacheService.getScriptCache().remove(`rowidx_${sheetId}_${tabName}`);
}

// เรียกจากปุ่ม "📥 นำเข้าข้อมูล" — ดึงผล OCR จากแท็บ OCR_RESULTS มาบันทึกลง SUMMARY
function importOcrResult(event, userId, seq) {
  const userProperties = PropertiesService.getUserProperties();
  const sheetId = userProperties.getProperty(userId + '_sheetId');

  if (!sheetId) {
    replyText(event.replyToken, '⚠️ ไม่พบแผ่นงานที่กำลังใช้งาน กรุณาเลือกแผ่นงานก่อนครับ');
    return;
  }

  const ss = SpreadsheetApp.openById(sheetId);
  const ocrSheet = ss.getSheetByName('OCR_RESULTS');
  if (!ocrSheet) {
    replyNoOcrDataYet(event.replyToken, seq, `⏳ ยังไม่มีผลลัพธ์ OCR สำหรับ SEQ "${seq}" ครับ อาจกำลังประมวลผลอยู่ รออีกสักครู่แล้วลองใหม่`);
    return;
  }

  const rowIndex = findRowBySeqCached(sheetId, 'OCR_RESULTS', seq);

  if (rowIndex === -1) {
    replyNoOcrDataYet(event.replyToken, seq, `⏳ ยังไม่มีผลลัพธ์ OCR สำหรับ SEQ "${seq}" ครับ อาจกำลังประมวลผลอยู่ รออีกสักครู่แล้วลองใหม่`);
    return;
  }

  const row = ocrSheet.getRange(rowIndex, 1, 1, 11).getValues()[0];
  const status = row[2];        // C: Status
  const remarkCol = row[8];     // I: Remark / error message
  const importStatus = row[9];  // J: ImportStatus
  const queuedAtMs = row[10];   // K: QueuedAtMs

  // ข้อ 4.2: ถ้าส่งไป OCR แล้วเกิน 1 นาทีแต่ callback ยังไม่มา ให้แจ้งว่าอาจ error แทนที่จะบอกให้รอเฉยๆ ตลอดไป
  if (status === 'queued') {
    const elapsedMs = queuedAtMs ? (Date.now() - Number(queuedAtMs)) : 0;
    if (elapsedMs > OCR_TIMEOUT_MS) {
      replyNoOcrDataYet(event.replyToken, seq, `⚠️ ประมวลผล OCR สำหรับ SEQ "${seq}" นานเกิน 1 นาทีแล้วแต่ยังไม่ได้ผลลัพธ์ อาจเกิดข้อผิดพลาดระหว่างประมวลผล\nกรุณาถ่ายรูป Passport ใหม่อีกครั้งครับ`);
    } else {
      replyNoOcrDataYet(event.replyToken, seq, `⏳ ยังไม่มีผลลัพธ์ OCR สำหรับ SEQ "${seq}" ครับ อาจกำลังประมวลผลอยู่ รออีกสักครู่แล้วลองใหม่`);
    }
    return;
  }

  if (status === 'error') {
    replyNoOcrDataYet(event.replyToken, seq, `❌ OCR อ่าน SEQ "${seq}" ไม่สำเร็จ: ${remarkCol || 'ไม่ทราบสาเหตุ'}\nกรุณาถ่ายรูป Passport ใหม่อีกครั้งครับ`);
    return;
  }

  if (importStatus === 'imported') {
    replyText(event.replyToken, `ℹ️ SEQ "${seq}" นำเข้าข้อมูลไปแล้วก่อนหน้านี้ครับ`);
    return;
  }

  const summarySheet = ss.getSheetByName('SUMMARY');
  const targetRow = findRowBySeqCached(sheetId, 'SUMMARY', seq);

  if (targetRow === -1) {
    replyText(event.replyToken, `❌ ไม่พบหมายเลข SEQ "${seq}" ในแท็บ SUMMARY`);
    return;
  }

  const nationality = row[3] || '';
  const passportNo = row[4] || '';
  const sex = row[5] || '';
  const regexName = row[6] || '';
  const peName = row[7] || '';
  const remark = row[8] || '';

  if (nationality) summarySheet.getRange(targetRow, 4).setValue(nationality);
  if (passportNo) summarySheet.getRange(targetRow, 5).setValue(passportNo);
  if (sex === 'M') {
    summarySheet.getRange(targetRow, 9).setValue(1);
    summarySheet.getRange(targetRow, 10).setValue('');
  } else if (sex === 'F') {
    summarySheet.getRange(targetRow, 9).setValue('');
    summarySheet.getRange(targetRow, 10).setValue(1);
  }

  userProperties.setProperty(userId + '_PASSPORT_NO', passportNo);
  userProperties.setProperty(userId + '_TEMP_ROW', targetRow.toString());
  userProperties.setProperty(userId + '_NAME_REGEX', regexName);
  userProperties.setProperty(userId + '_NAME_PE', peName);

  // Mark ว่า import แล้ว: ขีดฆ่าทั้งแถว + คอลัมน์สุดท้ายใส่ imported
  const fullRowRange = ocrSheet.getRange(rowIndex, 1, 1, ocrSheet.getLastColumn());
  fullRowRange.setFontLine('line-through');
  ocrSheet.getRange(rowIndex, 10).setValue('imported');

  // ข้อ 5.2: ถ้ามี nationality_mismatch (remark ไม่ว่าง) เน้นคำเตือนให้เห็นชัดเจน แยกเป็นบรรทัดพิเศษ ไม่ใช่แค่แปะเงียบๆ ท้ายข้อความ
  const remarkMsg = remark ? `\n\n⚠️⚠️ คำเตือน: ${remark} ⚠️⚠️\nกรุณาตรวจสอบสัญชาติ/ประเทศผู้ออกเล่มอีกครั้งก่อนยืนยันข้อมูล` : '';
  replyText(event.replyToken, `✅ นำเข้าข้อมูล Passport SEQ [ ${seq} ] เรียบร้อยแล้ว!${remarkMsg}\n\nถ่ายเอกสารอื่นครบแล้วกด "🏁 จบงาน" เพื่อเลือกชื่อ-นามสกุลได้เลยครับ`);
}

function showSummaryAndNameOptions(event, userId) {
  const userProperties = PropertiesService.getUserProperties();
  const regexName = userProperties.getProperty(userId + '_NAME_REGEX') || 'ไม่สามารถสกัดได้';
  const peName = userProperties.getProperty(userId + '_NAME_PE') || 'ไม่สามารถสกัดได้';

  const flexMessage = {
    "type": "flex",
    "altText": "สรุปข้อมูลและเลือกชื่อ-นามสกุล",
    "contents": {
      "type": "bubble",
      "body": {
        "type": "box",
        "layout": "vertical",
        "contents": [
          { "type": "text", "text": "📋 สรุปผลการอ่านชื่อ-นามสกุล", "weight": "bold", "size": "md", "color": "#1DB446" },
          { "type": "text", "text": "กรุณาเลือกรูปแบบชื่อที่ถูกต้องเพื่อลงตาราง:", "size": "xs", "color": "#888888", "margin": "xs" },
          { "type": "separator", "margin": "md" },
          {
            "type": "box",
            "layout": "vertical",
            "margin": "md",
            "spacing": "sm",
            "contents": [
              {
                "type": "button",
                "style": "primary",
                "height": "sm",
                "action": {
                  "type": "postback",
                  "label": `1. Regex: ${regexName.substring(0, 20)}`,
                  "data": `action=confirm_name_selection&choice=REGEX`,
                  "displayText": `เลือกชื่อ: ${regexName}`
                }
              },
              {
                "type": "button",
                "style": "secondary",
                "height": "sm",
                "action": {
                  "type": "postback",
                  "label": `2. PassportEye: ${peName.substring(0, 20)}`,
                  "data": `action=confirm_name_selection&choice=PE`,
                  "displayText": `เลือกชื่อ: ${peName}`
                }
              },
              {
                "type": "button",
                "style": "link",
                "color": "#888888",
                "action": {
                  "type": "postback",
                  "label": "3. ไม่เลือก (เว้นว่างไว้)",
                  "data": `action=confirm_name_selection&choice=NONE`,
                  "displayText": "ไม่เลือกชื่อ (เว้นว่าง)"
                }
              }
            ]
          }
        ]
      }
    }
  };

  sendLineReply(event.replyToken, [flexMessage]);
}

function saveFinalNameAndComplete(event, userId, choice) {
  const userProperties = PropertiesService.getUserProperties();
  const sheetId = userProperties.getProperty(userId + '_sheetId');
  const targetRowStr = userProperties.getProperty(userId + '_TEMP_ROW');

  if (sheetId && targetRowStr) {
    const ss = SpreadsheetApp.openById(sheetId);
    const summarySheet = ss.getSheetByName('SUMMARY');
    const targetRow = parseInt(targetRowStr, 10);

    let finalName = "";
    if (choice === 'REGEX') {
      finalName = userProperties.getProperty(userId + '_NAME_REGEX') || "";
    } else if (choice === 'PE') {
      finalName = userProperties.getProperty(userId + '_NAME_PE') || "";
    }

    if (finalName) {
      summarySheet.getRange(targetRow, 6).setValue(finalName);
    }
  }

  userProperties.deleteProperty(userId + '_TEMP_ROW');
  userProperties.deleteProperty(userId + '_NAME_REGEX');
  userProperties.deleteProperty(userId + '_NAME_PE');

  // ข้อ 3.7: ล้างคิว/ตัวนับรูป pending ของ SEQ นี้ทิ้ง เพื่อไม่ให้ปนกับ SEQ ใหม่รอบถัดไป
  const finishedSeq = userProperties.getProperty(userId + '_seq');
  clearPendingQueueState(userId, finishedSeq);

  // ข้อ 1: SEQ นี้จบงานแล้ว เอาออกจากรายการ "SEQ ที่จองไว้แต่ยังไม่จบงาน" ของผู้ใช้คนนี้
  if (sheetId && finishedSeq) {
    const userNameForList = getLineUserProfile(userId);
    removeBookedSeq(sheetId, userNameForList, finishedSeq);
  }

  sendTaskCompletionQuickReply(event.replyToken);
}

// ==========================================
// ข้อมูลเพิ่มเติมให้ SUMMARY (ข้อ 6) — popup form: G/H/K/L/N=dropdown, M=checkbox(DEPORT), O=note
// ==========================================
// อ่านค่า dropdown จากคอลัมน์เดียวในแท็บอ้างอิง (GROUP/VISA/CLAUSE) ตัดค่าว่างและค่าซ้ำออก
function getColumnValuesForDropdown(sheetId, tabName, columnLetter) {
  try {
    const ss = SpreadsheetApp.openById(sheetId);
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) return [];
    const colIndex = columnLetter.toUpperCase().charCodeAt(0) - 64; // 'A' -> 1, 'M' -> 13
    const lastRow = sheet.getLastRow();
    if (lastRow < 1) return [];
    const values = sheet.getRange(1, colIndex, lastRow, 1).getValues().map(row => String(row[0]).trim());
    return [...new Set(values.filter(v => v !== ''))];
  } catch (err) {
    debugLog(`getColumnValuesForDropdown error (${tabName}!${columnLetter}): ${err}`);
    return [];
  }
}

// เสิร์ฟหน้า popup กรอกข้อมูลเพิ่มเติม (ข้อ 6) — pre-fill ด้วยค่าที่มีอยู่แล้วในแถวของ SEQ นี้ถ้ามี
function renderExtraInfoPage(e) {
  const sheetId = e.parameter.sheetId;
  const sheetName = e.parameter.sheetName || '';
  const seq = e.parameter.seq;
  const uid = e.parameter.uid;
  // เหตุผลเดียวกับ renderManagePhotosPage — ต้องประกอบ URL /exec จริงเอง ห้ามใช้ window.location.href
  const apiUrl = buildPopupUrl('extra_info', { sheetId, sheetName, seq, uid });

  const groupOldOptions = getColumnValuesForDropdown(sheetId, 'GROUP', 'A');
  const groupNewOptions = getColumnValuesForDropdown(sheetId, 'GROUP', 'B');
  const visaOptions = getColumnValuesForDropdown(sheetId, 'VISA', 'M');
  const clauseOptions = getColumnValuesForDropdown(sheetId, 'CLAUSE', 'A');

  let existing = { g: '', h: '', k: '', l: '', m: false, n: '', o: '' };
  const targetRow = findRowBySeqCached(sheetId, 'SUMMARY', seq);
  if (targetRow !== -1) {
    const ss = SpreadsheetApp.openById(sheetId);
    const summarySheet = ss.getSheetByName('SUMMARY');
    const rowValues = summarySheet.getRange(targetRow, 7, 1, 9).getValues()[0]; // คอลัมน์ G..O (7..15)
    existing = {
      g: rowValues[0] || '', h: rowValues[1] || '',
      k: rowValues[4] || '', l: rowValues[5] || '',
      m: !!rowValues[6], n: rowValues[7] || '', o: rowValues[8] || ''
    };
  }

  function buildSelect(id, label, options, selected) {
    const optionsHtml = options.map(opt =>
      `<option value="${escapeHtml(opt)}" ${opt === selected ? 'selected' : ''}>${escapeHtml(opt)}</option>`
    ).join('');
    return `
      <div class="field">
        <label>${label}</label>
        <select id="${id}">
          <option value="">— ไม่ระบุ —</option>
          ${optionsHtml}
        </select>
      </div>`;
  }

  const html = `
    <style>
      ${POPUP_SHARED_STYLE}
      .field { padding: 12px; border-bottom: 1px solid #f0f0f0; }
      .field:last-child { border-bottom: none; }
      .field label { display: block; font-size: 13px; font-weight: 700; color: #555; margin-bottom: 6px; }
      select, textarea { width: 100%; padding: 10px; border-radius: 8px; border: 1px solid #ddd; font-size: 14px; background: #fafafa; }
      textarea { resize: vertical; min-height: 70px; font-family: inherit; }
      .checkbox-field { display: flex; align-items: center; gap: 8px; }
      .checkbox-field input { width: 20px; height: 20px; accent-color: #06c755; }
    </style>
    <header>
      📝 ข้อมูลเพิ่มเติม
      <small>SEQ ${escapeHtml(seq)} • ${escapeHtml(sheetName)}</small>
    </header>
    <div class="container" id="formView">
      <div class="card">
        ${buildSelect('groupOld', 'กลุ่มเดิม (6 กลุ่ม)', groupOldOptions, existing.g)}
        ${buildSelect('groupNew', 'กลุ่มใหม่ (10 กลุ่ม)', groupNewOptions, existing.h)}
        ${buildSelect('visaNow', 'VISA (NOW)', visaOptions, existing.k)}
        ${buildSelect('visaEx', 'VISA (EX)', visaOptions, existing.l)}
        <div class="field checkbox-field">
          <input type="checkbox" id="deport" ${existing.m ? 'checked' : ''}>
          <label for="deport" style="margin:0;">DEPORT</label>
        </div>
        ${buildSelect('clauses', 'CLAUSES', clauseOptions, existing.n)}
        <div class="field">
          <label>NOTE</label>
          <textarea id="note" placeholder="พิมพ์หมายเหตุ...">${escapeHtml(existing.o)}</textarea>
        </div>
      </div>
    </div>
    <div class="done-screen" id="doneView" style="display:none;"></div>
    <div class="footer-bar" id="footerBar">
      <button class="btn-primary" id="btnSave" style="width:100%;">💾 บันทึก</button>
    </div>
    <script>
      var BASE_URL = ${JSON.stringify(apiUrl)};
      document.getElementById('btnSave').addEventListener('click', function () {
        var btn = document.getElementById('btnSave');
        btn.disabled = true;
        var payload = {
          action: 'save_summary_extra',
          groupOld: document.getElementById('groupOld').value,
          groupNew: document.getElementById('groupNew').value,
          visaNow: document.getElementById('visaNow').value,
          visaEx: document.getElementById('visaEx').value,
          deport: document.getElementById('deport').checked,
          clauses: document.getElementById('clauses').value,
          note: document.getElementById('note').value
        };
        fetch(BASE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(payload)
        }).then(function (r) { return r.json(); }).then(function (res) {
          if (!res.success) throw new Error(res.error || 'บันทึกไม่สำเร็จ');
          document.getElementById('formView').style.display = 'none';
          document.getElementById('footerBar').style.display = 'none';
          var doneView = document.getElementById('doneView');
          doneView.style.display = 'block';
          doneView.innerHTML = '<div class="icon">✅</div><p>บันทึกข้อมูลเพิ่มเติมเรียบร้อยแล้ว</p><p style="color:#999;font-size:13px;">กดปุ่มปิด (✕) มุมขวาบนเพื่อกลับไปที่แชทได้เลยครับ</p>';
        }).catch(function (err) {
          btn.disabled = false;
          alert('เกิดข้อผิดพลาด: ' + (err && err.message ? err.message : err));
        });
      });
    </script>`;

  return HtmlService.createHtmlOutput(html)
    .setTitle('ข้อมูลเพิ่มเติม — SEQ ' + seq)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// เรียกจาก doPost เมื่อหน้า popup ข้อมูลเพิ่มเติมกด "บันทึก"
function handleSaveSummaryExtra(e, body) {
  try {
    const sheetId = e.parameter.sheetId;
    const seq = e.parameter.seq;
    const uid = e.parameter.uid;
    if (!sheetId || !seq) {
      return jsonResponse({ success: false, error: 'พารามิเตอร์ไม่ครบ' });
    }

    const targetRow = findRowBySeqCached(sheetId, 'SUMMARY', seq);
    if (targetRow === -1) {
      return jsonResponse({ success: false, error: `ไม่พบหมายเลข SEQ "${seq}" ในแท็บ SUMMARY` });
    }

    const ss = SpreadsheetApp.openById(sheetId);
    const summarySheet = ss.getSheetByName('SUMMARY');
    withLock(() => {
      summarySheet.getRange(targetRow, 7).setValue(body.groupOld || '');   // G
      summarySheet.getRange(targetRow, 8).setValue(body.groupNew || '');   // H
      summarySheet.getRange(targetRow, 11).setValue(body.visaNow || '');   // K
      summarySheet.getRange(targetRow, 12).setValue(body.visaEx || '');    // L
      summarySheet.getRange(targetRow, 13).setValue(body.deport ? 1 : ''); // M (DEPORT)
      summarySheet.getRange(targetRow, 14).setValue(body.clauses || '');   // N
      summarySheet.getRange(targetRow, 15).setValue(body.note || '');      // O
    });

    if (uid) {
      pushText(uid, `📝 บันทึกข้อมูลเพิ่มเติมของ SEQ ${seq} เรียบร้อยแล้วครับ`);
    }

    return jsonResponse({ success: true });
  } catch (err) {
    debugLog('handleSaveSummaryExtra error: ' + err);
    return jsonResponse({ success: false, error: err.message });
  }
}

function sendTaskCompletionQuickReply(replyToken) {
  const message = {
    "type": "text",
    "text": "✅ บันทึกข้อมูลและจัดเก็บไฟล์เรียบร้อยแล้วครับ!\n----------------------------------\n👇 เลือกรายการที่ต้องการทำต่อได้เลยครับ:",
    "quickReply": {
      "items": [
        {
          "type": "action",
          "action": {
            "type": "postback",
            "label": "📸 เลือก SEQ",
            "data": "action=menu_select_seq",
            "displayText": "เลือก SEQ เคสถัดไป"
          }
        },
        {
          "type": "action",
          "action": {
            "type": "postback",
            "label": "📌 จอง SEQ",
            "data": "action=menu_reserve_seq",
            "displayText": "จอง SEQ"
          }
        },
        {
          "type": "action",
          "action": {
            "type": "postback",
            "label": "🏁 สิ้นสุด",
            "data": "action=menu_end",
            "displayText": "สิ้นสุดการทำงาน"
          }
        }
      ]
    }
  };
  sendLineReply(replyToken, [message]);
}

// ==========================================
// HELPER & UTILITY FUNCTIONS
// ==========================================
function clearAllUserProperties(userProperties, userId) {
  userProperties.deleteProperty(userId + '_sheetId');
  userProperties.deleteProperty(userId + '_sheetName');
  userProperties.deleteProperty(userId + '_seq');
  userProperties.deleteProperty(userId + '_awaitingSeq');
  userProperties.deleteProperty(userId + '_awaitingBookingCount');
  userProperties.deleteProperty(userId + '_pendingFlightSeqs');
  userProperties.deleteProperty(userId + '_PASSPORT_NO');
  userProperties.deleteProperty(userId + '_TEMP_ROW');
  userProperties.deleteProperty(userId + '_NAME_REGEX');
  userProperties.deleteProperty(userId + '_NAME_PE');

  // กวาดล้าง key คิว pending/manageTotal ที่ผูกกับ SEQ ต่างๆ ของ user นี้ทิ้งด้วย (ชื่อ key เป็นแบบไดนามิกต่อ SEQ เลย list ตายตัวไม่ได้)
  const prefixQueue = `${userId}_pendingQueue_`;
  const prefixTotal = `${userId}_manageTotal_`;
  const allKeys = userProperties.getKeys();
  for (const key of allKeys) {
    if (key.indexOf(prefixQueue) === 0 || key.indexOf(prefixTotal) === 0) {
      userProperties.deleteProperty(key);
    }
  }
}

function formatFlightNo(rawFlightNo) {
  if (!rawFlightNo) return '';
  return String(rawFlightNo).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function getLineUserProfile(userId) {
  try {
    const url = `https://api.line.me/v2/bot/profile/${userId}`;
    const response = UrlFetchApp.fetch(url, {
      headers: { 'Authorization': 'Bearer ' + CHANNEL_ACCESS_TOKEN }
    });
    const profile = JSON.parse(response.getContentText());
    return profile.displayName || 'ผู้ใช้งาน';
  } catch (e) {
    return 'ผู้ใช้งาน';
  }
}

// จองแถว SEQ ว่างใน SUMMARY ให้ครบจำนวนที่ขอ ถ้าแถวว่างไม่พอจะ auto-extend แถวใหม่ให้อัตโนมัติ
// (เลข SEQ ของแถวใหม่เกิดจากฟอร์มูลาที่มีอยู่แล้วในชีต ไม่ใช่สคริปต์เป็นคน generate)
// ครอบด้วย LockService เพราะเสี่ยงจองซ้ำกันมากที่สุดถ้ามีหลายคนกดพร้อมกัน
function processBookingInSummarySheet(sheetId, count, userName) {
  return withLock(() => {
    const ss = SpreadsheetApp.openById(sheetId);
    const summarySheet = ss.getSheetByName('SUMMARY');
    if (!summarySheet) throw new Error('ไม่พบแท็บ "SUMMARY"');

    let lastRow = summarySheet.getLastRow();
    if (lastRow < 2) throw new Error('ไม่พบข้อมูลแถว SEQ ในแท็บ SUMMARY');

    const bookedSeqs = [];
    let remainingCount = count;
    const todayStr = Utilities.formatDate(new Date(), "GMT+7", "dd/MM/yyyy");
    const bookingText = `จองโดย ${userName}`;

    const scanAndBook = (fromRow, toRow) => {
      if (fromRow > toRow || remainingCount <= 0) return;
      const values = summarySheet.getRange(fromRow, 1, toRow - fromRow + 1, 5).getValues();
      for (let i = 0; i < values.length; i++) {
        const seq = values[i][0];
        const colEVal = values[i][4];
        if (seq !== '' && (!colEVal || String(colEVal).trim() === '')) {
          const targetRow = fromRow + i;
          summarySheet.getRange(targetRow, 2).setValue(todayStr);
          summarySheet.getRange(targetRow, 5).setValue(bookingText);
          bookedSeqs.push(seq);
          remainingCount--;
          if (remainingCount === 0) break;
        }
      }
    };

    scanAndBook(2, lastRow);

    if (remainingCount > 0) {
      const extendCount = remainingCount * 2; // เผื่อพอ ถ้าเกินไม่เป็นไร รอบถัดไปใช้ต่อได้
      summarySheet.insertRowsAfter(lastRow, extendCount);
      summarySheet.getRange(lastRow, 1).copyTo(
        summarySheet.getRange(lastRow + 1, 1, extendCount, 1),
        SpreadsheetApp.CopyPasteType.PASTE_FORMULA,
        false
      );
      SpreadsheetApp.flush();
      invalidateSeqRowCache(sheetId, 'SUMMARY'); // แถวใหม่ถูกเพิ่ม ต้องล้างแคช index เดิมทิ้ง (ข้อ 5.3)
      scanAndBook(lastRow + 1, lastRow + extendCount);
    }

    if (bookedSeqs.length === 0) throw new Error('ไม่มีแถว SEQ ว่างที่สามารถจองได้เลยครับ');
    return bookedSeqs;
  });
}

function updateFlightNoInSummarySheet(sheetId, seqList, flightNo) {
  withLock(() => {
    const ss = SpreadsheetApp.openById(sheetId);
    const summarySheet = ss.getSheetByName('SUMMARY');
    if (!summarySheet) throw new Error('ไม่พบแท็บ "SUMMARY"');

    const data = summarySheet.getDataRange().getValues();
    const seqsToUpdate = Array.isArray(seqList) ? seqList.map(s => String(s).trim()) : [String(seqList).trim()];

    for (let i = 1; i < data.length; i++) {
      const currentSeq = String(data[i][0]).trim();
      if (seqsToUpdate.includes(currentSeq)) {
        summarySheet.getRange(i + 1, 3).setValue(flightNo);
      }
    }
  });
}

function isStopCommand(event) {
  if (event.type === 'message' && event.message.type === 'text') {
    return event.message.text.trim().toLowerCase() === 'stop';
  }
  return false;
}

function isResetCommand(event) {
  if (event.type === 'message' && event.message.type === 'sticker') return true;
  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim();
    const lowerText = text.toLowerCase();
    if (['exit', 'เลือกไฟล์', 'เริ่มต้น', 'start'].includes(lowerText)) return true;
    const emojiRegex = /(\u00a9|\u00ae|[\u2000-\u3300]|\ud83c[\ud000-\udfff]|\ud83d[\ud000-\udfff]|\ud83e[\ud000-\udfff])/g;
    if (emojiRegex.test(text) && text.length <= 4) return true;
  }
  return false;
}

const PENDING_FILE_MAX_AGE_HOURS = 24;

// ลบไฟล์ _PENDING_ ที่ค้างเกิน 24 ชม. ใน Drive (กรณีเจ้าหน้าที่ส่งรูปแล้วไม่กดเลือกประเภทเลย)
// รันโดย time-driven trigger เท่านั้น (ตั้งครั้งเดียวหลัง deploy ด้วย setupCleanupTrigger())
function cleanupPendingFiles() {
  const mainFolders = DriveApp.getFoldersByName(MAIN_FOLDER_NAME);
  if (!mainFolders.hasNext()) return;
  const mainFolder = mainFolders.next();
  const photoFolders = mainFolder.getFoldersByName('PHOTO');
  if (!photoFolders.hasNext()) return;
  const photoFolder = photoFolders.next();

  const cutoffMs = PENDING_FILE_MAX_AGE_HOURS * 60 * 60 * 1000;
  const now = new Date().getTime();
  let deletedCount = 0;

  const subFolders = photoFolder.getFolders();
  while (subFolders.hasNext()) {
    const subFolder = subFolders.next();
    const files = subFolder.getFiles();
    while (files.hasNext()) {
      const file = files.next();
      if (file.getName().indexOf('_PENDING_') === -1) continue;
      const ageMs = now - file.getDateCreated().getTime();
      if (ageMs > cutoffMs) {
        file.setTrashed(true);
        deletedCount++;
      }
    }
  }
  debugLog(`cleanupPendingFiles: ลบไฟล์ PENDING ที่ค้างเกิน ${PENDING_FILE_MAX_AGE_HOURS} ชม. ไปทั้งหมด ${deletedCount} ไฟล์`);
}

// รันฟังก์ชันนี้ "ครั้งเดียว" ด้วยตนเองใน Apps Script Editor (กด Run) หลัง deploy
// เพื่อตั้ง time-driven trigger ให้ cleanupPendingFiles() รันอัตโนมัติทุก 6 ชั่วโมง
function setupCleanupTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  for (const t of triggers) {
    if (t.getHandlerFunction() === 'cleanupPendingFiles') {
      ScriptApp.deleteTrigger(t);
    }
  }
  ScriptApp.newTrigger('cleanupPendingFiles').timeBased().everyHours(6).create();
}

function getOrCreatePhotoFolder(mainFolderName, sheetName) {
  const mainFolders = DriveApp.getFoldersByName(mainFolderName);
  let mainFolder = mainFolders.hasNext() ? mainFolders.next() : DriveApp.createFolder(mainFolderName);
  const photoFolders = mainFolder.getFoldersByName('PHOTO');
  let photoFolder = photoFolders.hasNext() ? photoFolders.next() : mainFolder.createFolder('PHOTO');
  const subFolders = photoFolder.getFoldersByName(sheetName);
  return subFolders.hasNext() ? subFolders.next() : photoFolder.createFolder(sheetName);
}

function deleteExistingDriveFile(folder, fileName) {
  const existingFiles = folder.getFilesByName(fileName);
  while (existingFiles.hasNext()) {
    existingFiles.next().setTrashed(true);
  }
}

function findSeqRowInSheet(sheetId, seq) {
  const ss = SpreadsheetApp.openById(sheetId);
  const sheet = ss.getSheetByName('PHOTO');
  if (!sheet) throw new Error('ไม่พบแท็บ PHOTO');

  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(seq).trim()) {
      return i + 1;
    }
  }
  return -1;
}

// หาคอลัมน์ว่างถัดไปสำหรับรูป ETC ในแถวนี้ (เริ่มที่คอลัมน์ 7 ตามแท็บ PHOTO)
function getNextEtcColumn(sheetId, targetRow) {
  const ss = SpreadsheetApp.openById(sheetId);
  const sheet = ss.getSheetByName('PHOTO');
  let targetCol = 7;
  while (sheet.getRange(targetRow, targetCol).getValue() !== '') {
    targetCol++;
  }
  return targetCol;
}

function saveImageUrlToSheetRow(sheetId, targetRow, photoType, imageUrl, etcCol) {
  const ss = SpreadsheetApp.openById(sheetId);
  const sheet = ss.getSheetByName('PHOTO');
  const imageFormula = `=IMAGE("${imageUrl}")`;

  if (photoType === 'PASSPORT') sheet.getRange(targetRow, 4).setValue(imageFormula);
  else if (photoType === 'Return Ticket') sheet.getRange(targetRow, 5).setValue(imageFormula);
  else if (photoType === 'Accomodation') sheet.getRange(targetRow, 6).setValue(imageFormula);
  else if (photoType === 'ETC') {
    sheet.getRange(targetRow, etcCol).setValue(imageFormula);
  }
}

function findAllSheetsRecursive(folder, pathPrefix) {
  let results = [];
  const files = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
  while (files.hasNext()) {
    const file = files.next();
    results.push({ id: file.getId(), name: file.getName(), path: pathPrefix, updated: file.getLastUpdated().getTime() });
  }
  const subFolders = folder.getFolders();
  while (subFolders.hasNext()) {
    const sub = subFolders.next();
    const subPath = pathPrefix ? `${pathPrefix}/${sub.getName()}` : sub.getName();
    results = results.concat(findAllSheetsRecursive(sub, subPath));
  }
  return results;
}

function sendSheetFlexMenu(replyToken) {
  const mainFolders = DriveApp.getFoldersByName(MAIN_FOLDER_NAME);
  if (!mainFolders.hasNext()) {
    replyText(replyToken, `⚠️ ไม่พบโฟลเดอร์ "${MAIN_FOLDER_NAME}" ใน Google Drive`);
    return;
  }
  const mainFolder = mainFolders.next();
  const sheetList = findAllSheetsRecursive(mainFolder, '');
  if (sheetList.length === 0) {
    replyText(replyToken, `⚠️ ไม่พบไฟล์ Google Sheets ในโฟลเดอร์ "${MAIN_FOLDER_NAME}"`);
    return;
  }
  sheetList.sort((a, b) => b.updated - a.updated);
  const top5Sheets = sheetList.slice(0, 5);

  const buttons = top5Sheets.map((file, index) => {
    let labelText = file.path ? `${file.path}/${file.name}` : file.name;
    if (index === 0) labelText = `⭐️ [ล่าสุด] ${labelText}`;
    if (labelText.length > 30) labelText = labelText.substring(0, 27) + '...';
    return {
      type: 'button',
      style: index === 0 ? 'primary' : 'secondary',
      height: 'sm',
      action: {
        type: 'postback',
        label: labelText,
        data: `action=select_sheet&sheetId=${file.id}&sheetName=${encodeURIComponent(file.name)}`,
        displayText: `เลือกแผ่นงาน: ${file.name}`
      }
    };
  });

  const flexMessage = {
    type: 'flex',
    altText: 'เลือกแผ่นงาน Google Sheets',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '📊 เลือกแผ่นงาน Google Sheets', weight: 'bold', size: 'md', color: '#1DB446' },
          { type: 'text', text: 'กรุณาเลือกไฟล์ที่ต้องการใช้งาน (แสดง 5 ชีตล่าสุด):', size: 'xs', color: '#888888', margin: 'xs', wrap: true },
          { type: 'separator', margin: 'md' },
          { type: 'box', layout: 'vertical', margin: 'md', spacing: 'sm', contents: buttons }
        ]
      }
    }
  };
  sendLineReply(replyToken, [flexMessage]);
}

function replySeqPromptWithBookingOption(replyToken, textMessage) {
  const message = {
    type: 'text',
    text: textMessage,
    quickReply: {
      items: [
        { type: 'action', action: { type: 'postback', label: '📌 จอง SEQ', data: 'action=book_seq', displayText: 'จองSEQ' } }
      ]
    }
  };
  sendLineReply(replyToken, [message]);
}

function replyChangeSeqPrompt(replyToken, textMessage) {
  const message = {
    type: 'text',
    text: textMessage,
    quickReply: {
      items: [
        { type: 'action', action: { type: 'postback', label: '🔢 เปลี่ยน SEQ', data: 'action=menu_select_seq', displayText: 'ขอเปลี่ยน SEQ' } },
        { type: 'action', action: { type: 'postback', label: '📌 จอง SEQ', data: 'action=book_seq', displayText: 'จองSEQ' } }
      ]
    }
  };
  sendLineReply(replyToken, [message]);
}

function getImageBlobFromLine(messageId) {
  const url = `https://api-data.line.me/v2/bot/message/${messageId}/content`;
  return UrlFetchApp.fetch(url, { headers: { 'Authorization': 'Bearer ' + CHANNEL_ACCESS_TOKEN } }).getBlob();
}

function replyText(replyToken, text) {
  sendLineReply(replyToken, [{ type: 'text', text: text }]);
}

function sendLineReply(replyToken, messages) {
  const response = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CHANNEL_ACCESS_TOKEN },
    method: 'post',
    payload: JSON.stringify({ replyToken: replyToken, messages: messages }),
    muteHttpExceptions: true
  });
  const code = response.getResponseCode();
  if (code !== 200) {
    debugLog(`LINE reply API error ${code}: ${response.getContentText()}`);
    throw new Error(`LINE reply failed (${code}): ${response.getContentText()}`);
  }
  debugLog('LINE reply API OK (200)');
}

function pushMessages(userId, messages) {
  try {
    const response = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CHANNEL_ACCESS_TOKEN },
      method: 'post',
      payload: JSON.stringify({ to: userId, messages: messages }),
      muteHttpExceptions: true
    });
    const code = response.getResponseCode();
    if (code !== 200) {
      debugLog(`LINE push API error ${code}: ${response.getContentText()}`);
    }
  } catch (err) {
    debugLog('pushMessages failed: ' + err);
  }
}

function pushText(userId, text) {
  pushMessages(userId, [{ type: 'text', text: text }]);
}

function parseQueryString(queryString) {
  let query = {};
  let pairs = (queryString[0] === '?' ? queryString.substr(1) : queryString).split('&');
  for (let i = 0; i < pairs.length; i++) {
    let pair = pairs[i].split('=');
    query[decodeURIComponent(pair[0])] = decodeURIComponent(pair[1] || '');
  }
  return query;
}