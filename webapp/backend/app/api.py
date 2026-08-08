import time

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile

from app import drive, sheets
from app.schemas import (
    BasicOkResponse,
    BookingRequest,
    BookingResponse,
    DropdownOptions,
    ExtraInfoFields,
    ExtraInfoResponse,
    OcrPreviewResponse,
    PhotoResponse,
    SheetInfo,
)

router = APIRouter()


# ==========================================
# เลือกแผ่นงาน (พอร์ตจาก sendSheetFlexMenu)
# ==========================================
@router.get("/sheets", response_model=list[SheetInfo])
async def list_sheets():
    results = await drive.list_available_sheets()
    return [SheetInfo(id=s.id, name=s.name, path=s.path, updated_ms=s.updated_ms) for s in results]


async def _get_dropdowns(sheet_id: str) -> DropdownOptions:
    group_old = await sheets.get_column_values_for_dropdown(sheet_id, "GROUP", "A")
    group_new = await sheets.get_column_values_for_dropdown(sheet_id, "GROUP", "B")
    visa = await sheets.get_column_values_for_dropdown(sheet_id, "VISA", "M")
    clause = await sheets.get_column_values_for_dropdown(sheet_id, "CLAUSE", "A")
    return DropdownOptions(group_old=group_old, group_new=group_new, visa=visa, clause=clause)


@router.get("/sheets/{sheet_id}/dropdowns", response_model=DropdownOptions)
async def get_dropdowns(sheet_id: str):
    return await _get_dropdowns(sheet_id)


# ==========================================
# จอง SEQ (พอร์ตจาก processBookingInSummarySheet/updateFlightNoInSummarySheet)
# ==========================================
@router.post("/sheets/{sheet_id}/bookings", response_model=BookingResponse)
async def book_seqs(sheet_id: str, body: BookingRequest):
    try:
        booked = await sheets.book_seqs(sheet_id, body.count, body.user_name)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if body.flight_no:
        await sheets.update_flight_no(sheet_id, booked, body.flight_no)
    return BookingResponse(booked_seqs=booked)


# ==========================================
# ข้อมูลเพิ่มเติม (พอร์ตจาก renderExtraInfoPage/handleSaveSummaryExtra)
# ==========================================
@router.get("/sheets/{sheet_id}/seq/{seq}/extra-info", response_model=ExtraInfoResponse)
async def get_extra_info(sheet_id: str, seq: str, sheet_name: str = Query(...)):
    existing = await sheets.read_summary_extra(sheet_id, seq)
    if existing is None:
        raise HTTPException(status_code=404, detail=f'ไม่พบหมายเลข SEQ "{seq}" ในแท็บ SUMMARY')
    dropdowns = await _get_dropdowns(sheet_id)
    photo_url = await _find_photo_url(sheet_id, sheet_name, seq, "PASSPORT")
    return ExtraInfoResponse(
        nationality=existing.nationality,
        passport_no=existing.passport_no,
        name=existing.name,
        sex_m=existing.sex_m,
        sex_f=existing.sex_f,
        group_old=existing.group_old,
        group_new=existing.group_new,
        visa_now=existing.visa_now,
        visa_ex=existing.visa_ex,
        deport=existing.deport,
        clauses=existing.clauses,
        note=existing.note,
        passport_photo_url=photo_url,
        dropdowns=dropdowns,
    )


@router.put("/sheets/{sheet_id}/seq/{seq}/extra-info", response_model=BasicOkResponse)
async def save_extra_info(sheet_id: str, seq: str, body: ExtraInfoFields):
    fields = sheets.SummaryExtra(**body.model_dump())
    ok = await sheets.write_summary_extra(sheet_id, seq, fields)
    if not ok:
        raise HTTPException(status_code=404, detail=f'ไม่พบหมายเลข SEQ "{seq}" ในแท็บ SUMMARY')

    # ข้อ 12/14 เดิม: ถ้ามีการกรอก/แก้ไขข้อมูล OCR ในรอบนี้ มาร์คแถวใน OCR_RESULTS ว่านำเข้าแล้ว (ไว้ดูสถานะย้อนหลัง)
    if sheets.has_ocr_edits(fields):
        ocr_row = await sheets.get_ocr_result_row(sheet_id, seq)
        if ocr_row is not None and ocr_row.status == "done":
            await sheets.mark_ocr_result_imported(sheet_id, ocr_row.row_index)

    return BasicOkResponse(success=True)


# ==========================================
# OCR preview (พอร์ตจาก handleFetchOcrPreview)
# ==========================================
@router.get("/sheets/{sheet_id}/seq/{seq}/ocr-preview", response_model=OcrPreviewResponse)
async def get_ocr_preview(sheet_id: str, seq: str):
    info = await sheets.get_ocr_result_row(sheet_id, seq)
    if info is None:
        return OcrPreviewResponse(
            status="not_found",
            message=f'ยังไม่มีผลลัพธ์ OCR สำหรับ SEQ "{seq}" ครับ อาจกำลังประมวลผลอยู่ รออีกสักครู่แล้วลองใหม่',
        )

    if info.status == "queued":
        elapsed_ms = (time.time() * 1000 - info.queued_at_ms) if info.queued_at_ms is not None else 0
        if elapsed_ms > sheets.OCR_TIMEOUT_MS:
            return OcrPreviewResponse(
                status="error",
                message=(
                    f'ประมวลผล OCR สำหรับ SEQ "{seq}" นานเกิน 1 นาทีแล้วแต่ยังไม่ได้ผลลัพธ์ '
                    "อาจเกิดข้อผิดพลาดระหว่างประมวลผล\nกรุณาถ่ายรูป Passport ใหม่อีกครั้งครับ"
                ),
            )
        return OcrPreviewResponse(
            status="queued",
            message=f'ยังไม่มีผลลัพธ์ OCR สำหรับ SEQ "{seq}" ครับ อาจกำลังประมวลผลอยู่ รออีกสักครู่แล้วลองใหม่',
        )

    if info.status == "error":
        return OcrPreviewResponse(
            status="error",
            message=(
                f'OCR อ่าน SEQ "{seq}" ไม่สำเร็จ: {info.remark or "ไม่ทราบสาเหตุ"}\n'
                "กรุณาถ่ายรูป Passport ใหม่อีกครั้งครับ"
            ),
        )

    return OcrPreviewResponse(
        status="done",
        nationality=info.nationality,
        passport_no=info.passport_no,
        sex=info.sex,
        pe_name=info.pe_name,
        typhoon_name=info.typhoon_name,
        remark=info.remark,
    )


# ==========================================
# รูปถ่าย (พอร์ตจาก classifyAndSavePhoto/getPassportPhotoUrl — เฉพาะส่วนอัปโหลด/บันทึกลงชีต
# ยังไม่ trigger ส่ง OCR ให้ตอนนี้ เพราะ OCR pipeline ยังไม่มีจนกว่าจะถึง Phase 3)
# ==========================================
@router.post("/sheets/{sheet_id}/seq/{seq}/photos", response_model=PhotoResponse)
async def upload_photo(
    sheet_id: str,
    seq: str,
    sheet_name: str = Form(...),
    photo_type: str = Form(...),
    file: UploadFile = File(...),
):
    if photo_type not in drive.PHOTO_TYPE_FILE_LABELS:
        raise HTTPException(status_code=400, detail=f"ประเภทเอกสารไม่ถูกต้อง: {photo_type}")

    row = await sheets.find_seq_row_in_photo_tab(sheet_id, seq)
    if row is None:
        raise HTTPException(status_code=404, detail=f'ไม่พบหมายเลข SEQ "{seq}" ในแท็บ PHOTO')

    folder_id = await drive.get_or_create_photo_folder(sheet_name)
    content = await file.read()

    if photo_type == "ETC":
        etc_col = await sheets.get_next_etc_column(sheet_id, row)
        etc_index = etc_col - (sheets.ETC_FIRST_COLUMN_INDEX - 1)
        file_name = drive.photo_file_name(seq, "ETC", sheet_name, etc_index=etc_index)
        file_id = await drive.upload_photo(folder_id, file_name, content)
        url = drive.thumbnail_url(file_id)
        await sheets.save_image_url_to_photo_row(sheet_id, row, "ETC", url, etc_col=etc_col)
    else:
        label = drive.PHOTO_TYPE_FILE_LABELS[photo_type]
        file_name = drive.photo_file_name(seq, label, sheet_name)
        await drive.delete_existing_file(folder_id, file_name)  # ถ่ายซ้ำ = overwrite ทับไฟล์เดิม
        file_id = await drive.upload_photo(folder_id, file_name, content)
        url = drive.thumbnail_url(file_id)
        await sheets.save_image_url_to_photo_row(sheet_id, row, photo_type, url)

    return PhotoResponse(photo_type=photo_type, url=url)


@router.get("/sheets/{sheet_id}/seq/{seq}/photo", response_model=PhotoResponse)
async def get_photo(
    sheet_id: str, seq: str, sheet_name: str = Query(...), photo_type: str = Query(...)
):
    url = await _find_photo_url(sheet_id, sheet_name, seq, photo_type)
    if not url:
        raise HTTPException(status_code=404, detail="ไม่พบรูป")
    return PhotoResponse(photo_type=photo_type, url=url)


async def _find_photo_url(sheet_id: str, sheet_name: str, seq: str, photo_type: str) -> str:
    label = drive.PHOTO_TYPE_FILE_LABELS.get(photo_type)
    if not label:
        return ""
    folder_id = await drive.get_or_create_photo_folder(sheet_name)
    file_name = drive.photo_file_name(seq, label, sheet_name)
    file_id = await drive.find_file_by_name(folder_id, file_name)
    return drive.thumbnail_url(file_id) if file_id else ""
