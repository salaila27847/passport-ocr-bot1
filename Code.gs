// ==========================================
// CONFIGURATION & CONSTANTS
// ==========================================
const CHANNEL_ACCESS_TOKEN = "PT37Wr/xV+py61KhKIZrCwRLw9fzPPOD0iZ00yFXB3aI6R6iGHJSEu2Pa5MYyfShBq9V5ZwuYEQDAow3XDUdnUfDnNV/ShD+WXC2mCByEXmu7ckWCQPxI53/72NW8EBfk+NdtcyExD9FhCdQB4ekGwdB04t89/1O/w1cDnyilFU=";
const MAIN_FOLDER_NAME = "interview";
const RENDER_OCR_URL = "https://passport-ocr-bot1.onrender.com/ocr";
const RENDER_OCR_SUBMIT_URL = "https://passport-ocr-bot1.onrender.com/ocr/submit";
const SECRET_TOKEN = "hkt12345604";

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
    replyBatchAck(event.replyToken, seq, queue.length);
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
      replySeqPromptWithBookingOption(
        event.replyToken,
        `📊 คุณเลือกแผ่นงาน: "${data.sheetName}"\n\nกรุณาพิมพ์หมายเลข SEQ ที่ต้องการจัดการ หรือกดปุ่ม "จอง SEQ" ด้านล่าง:`
      );
      return;
    }

    // ระบุประเภทภาพถ่าย
    if (data.action === 'classify_image') {
      handleImageClassification(event, userId, data.fileId, data.type);
      return;
    }

    // เริ่ม/ทำต่อ การจัดการรูปในคิว pending ทีละใบ
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
      userProperties.setProperty(userId + '_awaitingSeq', 'true');
      replyText(event.replyToken, "📸 กรุณากรอกเลข SEQ สำหรับเคสถัดไป (เช่น 02 หรือ 105):");
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
        replySeqPromptWithBookingOption(
          event.replyToken,
          `🎉 **สรุปการจองสำเร็จ!**\n\n✈️ **Flight No.:** ${formattedFlightNo}\n📋 **รายการ SEQ ที่จอง (${bookedSeqs.length} คน):**\n${seqListStr}\n\n---------------------------\nกรุณาพิมพ์หมายเลข SEQ ที่ต้องการถ่ายรูปจัดการต่อได้เลยครับ:`
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
      replyText(event.replyToken, `📸 กำหนด SEQ: [ ${text} ] เรียบร้อยแล้ว\n\nคุณสามารถกดเลือกถ่ายรูป/ส่งรูปภาพเข้ามาได้รวดเดียวเลยครับ`);
      return;
    }

    replyChangeSeqPrompt(event.replyToken, `❓ ไม่เข้าใจข้อความ "${text}" ครับ\nหากต้องการเปลี่ยนหรือจบ SEQ ปัจจุบัน กดปุ่มด้านล่างได้เลย หรือพิมพ์ "EXIT" เพื่อเลือกแผ่นงานใหม่ / พิมพ์ "STOP" เพื่อหยุดทำงาน`);
  }
}

// ==========================================
// 📸 Image Handling & Single-Click Classification
// ==========================================

// ชื่อไฟล์ที่ใช้แสดงผลสำหรับแต่ละประเภทเอกสาร (photoType ภายในระบบ -> label ชื่อไฟล์)
const PHOTO_TYPE_FILE_LABELS = {
  'PASSPORT': 'PASSPORT',
  'Return Ticket': 'TICKET',
  'Accomodation': 'ACCOMMODATION',
  'ETC': 'ETC'
};

// ปุ่ม 4 ประเภทเอกสาร เรียง 2x2 (LINE Flex ไม่รองรับ layout "grid" ต้องใช้ vertical ซ้อน horizontal แทน)
function buildClassifyButtonsBox(fileId) {
  return {
    "type": "box",
    "layout": "vertical",
    "margin": "md",
    "spacing": "sm",
    "contents": [
      {
        "type": "box",
        "layout": "horizontal",
        "spacing": "sm",
        "contents": [
          { "type": "button", "style": "primary", "height": "sm", "action": { "type": "postback", "label": "📘 Passport", "data": `action=classify_image&type=PASSPORT&fileId=${fileId}` } },
          { "type": "button", "style": "secondary", "height": "sm", "action": { "type": "postback", "label": "✈️ Ticket", "data": `action=classify_image&type=Return Ticket&fileId=${fileId}` } }
        ]
      },
      {
        "type": "box",
        "layout": "horizontal",
        "spacing": "sm",
        "contents": [
          { "type": "button", "style": "secondary", "height": "sm", "action": { "type": "postback", "label": "🏨 Hotel", "data": `action=classify_image&type=Accomodation&fileId=${fileId}` } },
          { "type": "button", "style": "secondary", "height": "sm", "action": { "type": "postback", "label": "📁 ETC", "data": `action=classify_image&type=ETC&fileId=${fileId}` } }
        ]
      }
    ]
  };
}

// อัปโหลดรูปที่เพิ่งได้รับขึ้น Drive ทันที (ตั้งชื่อชั่วคราว) เพื่อเอา URL มาโชว์พรีวิวใน Flex Message
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

// สร้าง object ของ Flex classify menu (ใช้ทั้งตอนเริ่มจัดการรูป และตอนต่อรูปถัดไปในคิว)
function buildClassificationFlexMessage(fileId, imageUrl, headerText) {
  return {
    "type": "flex",
    "altText": "กรุณาระบุประเภทเอกสาร",
    "contents": {
      "type": "bubble",
      "hero": {
        "type": "image",
        "url": imageUrl,
        "size": "full",
        "aspectRatio": "4:3",
        "aspectMode": "cover"
      },
      "body": {
        "type": "box",
        "layout": "vertical",
        "contents": [
          { "type": "text", "text": headerText || "📌 ระบุประเภทเอกสารสำหรับรูปนี้", "weight": "bold", "size": "sm" },
          buildClassifyButtonsBox(fileId),
          { "type": "separator", "margin": "lg" },
          {
            "type": "button",
            "style": "link",
            "color": "#FF3B30",
            "action": { "type": "postback", "label": "🏁 จบงาน / สรุปข้อมูล", "data": "action=finish_case" }
          }
        ]
      }
    }
  };
}

function sendImageClassificationMenu(replyToken, fileId, imageUrl, headerText) {
  sendLineReply(replyToken, [buildClassificationFlexMessage(fileId, imageUrl, headerText)]);
}

// ใช้เมื่อส่ง Flex พร้อมรูป preview ไม่สำเร็จ (replyToken ใช้ไปแล้ว) - ส่งเมนูแบบไม่มีรูปผ่าน push แทน
function sendImageClassificationMenuFallback(userId, fileId) {
  const flexMessage = {
    "type": "flex",
    "altText": "กรุณาระบุประเภทเอกสาร",
    "contents": {
      "type": "bubble",
      "body": {
        "type": "box",
        "layout": "vertical",
        "contents": [
          { "type": "text", "text": "📌 ระบุประเภทเอกสารสำหรับรูปล่าสุด", "weight": "bold", "size": "sm" },
          { "type": "text", "text": "⚠️ ไม่สามารถแสดงรูปตัวอย่างได้ (การเชื่อมต่อรูปภาพจาก Google Drive ขัดข้องชั่วคราว) แต่ยังกดเลือกประเภทเอกสารด้านล่างได้ตามปกติครับ", "size": "xxs", "color": "#FF3B30", "wrap": true, "margin": "sm" },
          buildClassifyButtonsBox(fileId),
          { "type": "separator", "margin": "lg" },
          {
            "type": "button",
            "style": "link",
            "color": "#FF3B30",
            "action": { "type": "postback", "label": "🏁 จบงาน / สรุปข้อมูล", "data": "action=finish_case" }
          }
        ]
      }
    }
  };
  pushMessages(userId, [flexMessage]);
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

// ข้อความตอบกลับทันทีที่รับรูป (แทนการเด้ง Flex ทันที) พร้อม Quick Reply ให้กดจัดการรูปเมื่อพร้อม
function replyBatchAck(replyToken, seq, n) {
  const message = {
    type: 'text',
    text: `📸 SEQ: ${seq} รับรูปทั้งหมด ${n} รูปเรียบร้อยแล้ว\nรอจัดการรูป ${n}/${n}\n\nต้องการทำอะไรต่อดีครับ?`,
    quickReply: {
      items: [
        { type: 'action', action: { type: 'postback', label: '🗂️ จัดการรูป', data: 'action=manage_photos', displayText: 'จัดการรูป' } },
        { type: 'action', action: { type: 'postback', label: '📸 เลือก SEQ', data: 'action=menu_select_seq', displayText: 'เลือก SEQ' } },
        { type: 'action', action: { type: 'postback', label: '📌 จอง SEQ', data: 'action=menu_reserve_seq', displayText: 'จอง SEQ' } }
      ]
    }
  };
  sendLineReply(replyToken, [message]);
}

function seqNavQuickReplyItems(includeEnd) {
  const items = [
    { type: 'action', action: { type: 'postback', label: '📸 เลือก SEQ', data: 'action=menu_select_seq', displayText: 'เลือก SEQ' } },
    { type: 'action', action: { type: 'postback', label: '📌 จอง SEQ', data: 'action=menu_reserve_seq', displayText: 'จอง SEQ' } }
  ];
  if (includeEnd) {
    items.push({ type: 'action', action: { type: 'postback', label: '🏁 สิ้นสุด', data: 'action=menu_end', displayText: 'สิ้นสุด' } });
  }
  return items;
}

// ปุ่ม "🗂️ จัดการรูป" — หยิบรูปแรกจากคิว pending ของ SEQ ปัจจุบันมาโชว์ Flex ให้จำแนก
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

  userProperties.setProperty(userId + '_manageTotal_' + seq, String(queue.length));
  const first = queue[0];
  const headerText = `📌 SEQ ${seq} — ระบุประเภทเอกสาร (เหลือ ${queue.length} รูป)`;

  try {
    const flexMessage = buildClassificationFlexMessage(first.fileId, first.imageUrl, headerText);
    flexMessage.quickReply = { items: seqNavQuickReplyItems(false) };
    sendLineReply(event.replyToken, [flexMessage]);
  } catch (err) {
    debugLog('handleManagePhotos flex failed, fallback: ' + err);
    sendImageClassificationMenuFallback(userId, first.fileId);
  }
}

function handleImageClassification(event, userId, fileId, photoType) {
  const userProperties = PropertiesService.getUserProperties();
  const sheetId = userProperties.getProperty(userId + '_sheetId');
  const sheetName = userProperties.getProperty(userId + '_sheetName');
  const seq = userProperties.getProperty(userId + '_seq');

  try {
    const targetRow = findSeqRowInSheet(sheetId, seq);
    if (targetRow === -1) {
      replyText(event.replyToken, `❌ ไม่พบหมายเลข SEQ "${seq}" ในคอลัมน์ A ของแท็บ PHOTO`);
      return;
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

    // เอาออกจากคิว pending แล้วคำนวณ progress สำหรับ flow "จัดการรูป" (ข้อ 3.6)
    const remainingQueue = removeFromPendingQueue(userId, seq, fileId);
    const manageTotalStr = userProperties.getProperty(userId + '_manageTotal_' + seq);
    const total = manageTotalStr ? parseInt(manageTotalStr, 10) : (remainingQueue.length + 1);
    const remaining = remainingQueue.length;

    const messages = [];
    let includeImportButton = false;

    if (photoType === 'PASSPORT') {
      const queued = submitPassportOcrAsync(sheetId, seq, file.getBlob());
      if (queued) {
        recordOcrQueued(sheetId, seq);
        messages.push(buildOcrQueuedMessage(seq));
        includeImportButton = true;
      } else {
        messages.push({
          type: 'text',
          text: `⚠️ บันทึกรูป [Passport] แล้ว แต่ส่งไปประมวลผล OCR ไม่สำเร็จ\nลองกดปุ่ม "🔢 เปลี่ยน SEQ" แล้วเลือก SEQ นี้ใหม่เพื่อถ่ายซ้ำได้เลยครับ (ถ่ายซ้ำจะ overwrite ทับไฟล์ [Passport] เดิมของ SEQ นี้เสมอ ไม่มีไฟล์ซ้อนกัน)`
        });
      }
    } else {
      messages.push({ type: 'text', text: `✅ บันทึกรูปภาพเป็น [${photoType}] เรียบร้อยแล้ว` });
    }

    // LINE แสดง quickReply ของ "ข้อความสุดท้าย" เท่านั้นเมื่อส่งหลายข้อความพร้อมกัน จึงต้องรวมปุ่มทั้งหมด (นำเข้าข้อมูล/เลือก SEQ/จอง SEQ/สิ้นสุด) ไว้ที่ข้อความสุดท้าย
    if (remaining > 0) {
      messages.push({ type: 'text', text: `📋 อัพเดท SEQ: ${seq} รอจัดการรูป ${remaining}/${total}` });
      const next = remainingQueue[0];
      const nextFlex = buildClassificationFlexMessage(next.fileId, next.imageUrl, `📌 SEQ ${seq} — ระบุประเภทเอกสาร (เหลือ ${remaining} รูป)`);
      const items = seqNavQuickReplyItems(false);
      if (includeImportButton) items.unshift(importOcrQuickReplyItem(seq));
      nextFlex.quickReply = { items };
      messages.push(nextFlex);
    } else {
      const items = seqNavQuickReplyItems(true);
      if (includeImportButton) items.unshift(importOcrQuickReplyItem(seq));
      messages.push({
        type: 'text',
        text: `🎉 SEQ ${seq} จัดการรูปภาพครบ ${total}/${total} เรียบร้อย!\n\nถ่ายเอกสารอื่นครบแล้วกด "🏁 จบงาน" เพื่อสรุปข้อมูลได้เลยครับ`,
        quickReply: { items }
      });
      userProperties.deleteProperty(userId + '_manageTotal_' + seq);
    }

    sendLineReply(event.replyToken, messages);
  } catch (err) {
    debugLog('Classification error: ' + err);
    replyText(event.replyToken, `❌ เกิดข้อผิดพลาด: ${err.message}`);
  }
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

// คืน quickReply item เดียวสำหรับปุ่ม "นำเข้าข้อมูล" ของ SEQ นี้ (นำไปแปะรวมกับ quickReply ของข้อความสุดท้ายในชุด reply)
function importOcrQuickReplyItem(seq) {
  return {
    type: 'action',
    action: {
      type: 'postback',
      label: `📥 นำเข้าข้อมูล SEQ ${seq}`,
      data: `action=import_ocr&seq=${seq}`,
      displayText: `นำเข้าข้อมูล SEQ ${seq}`
    }
  };
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
    replyText(event.replyToken, `⏳ ยังไม่มีผลลัพธ์ OCR สำหรับ SEQ "${seq}" ครับ อาจกำลังประมวลผลอยู่ รออีกสักครู่แล้วลองใหม่`);
    return;
  }

  const rowIndex = findRowBySeqCached(sheetId, 'OCR_RESULTS', seq);

  if (rowIndex === -1) {
    replyText(event.replyToken, `⏳ ยังไม่มีผลลัพธ์ OCR สำหรับ SEQ "${seq}" ครับ อาจกำลังประมวลผลอยู่ รออีกสักครู่แล้วลองใหม่`);
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
      replyText(event.replyToken, `⚠️ ประมวลผล OCR สำหรับ SEQ "${seq}" นานเกิน 1 นาทีแล้วแต่ยังไม่ได้ผลลัพธ์ อาจเกิดข้อผิดพลาดระหว่างประมวลผล\nกรุณาถ่ายรูป Passport ใหม่อีกครั้งครับ`);
    } else {
      replyText(event.replyToken, `⏳ ยังไม่มีผลลัพธ์ OCR สำหรับ SEQ "${seq}" ครับ อาจกำลังประมวลผลอยู่ รออีกสักครู่แล้วลองใหม่`);
    }
    return;
  }

  if (status === 'error') {
    replyText(event.replyToken, `❌ OCR อ่าน SEQ "${seq}" ไม่สำเร็จ: ${remarkCol || 'ไม่ทราบสาเหตุ'}\nกรุณาถ่ายรูป Passport ใหม่อีกครั้งครับ`);
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
  clearPendingQueueState(userId, userProperties.getProperty(userId + '_seq'));

  sendTaskCompletionQuickReply(event.replyToken);
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