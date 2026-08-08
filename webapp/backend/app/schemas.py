from pydantic import BaseModel


class SheetInfo(BaseModel):
    id: str
    name: str
    path: str
    updated_ms: int


class DropdownOptions(BaseModel):
    group_old: list[str]
    group_new: list[str]
    visa: list[str]
    clause: list[str]


class BookingRequest(BaseModel):
    count: int
    user_name: str
    flight_no: str = ""


class BookingResponse(BaseModel):
    booked_seqs: list[str]


class ExtraInfoFields(BaseModel):
    nationality: str = ""
    passport_no: str = ""
    name: str = ""
    sex_m: bool = False
    sex_f: bool = False
    group_old: str = ""
    group_new: str = ""
    visa_now: str = ""
    visa_ex: str = ""
    deport: bool = False
    clauses: str = ""
    note: str = ""


class ExtraInfoResponse(ExtraInfoFields):
    passport_photo_url: str = ""
    dropdowns: DropdownOptions


class BasicOkResponse(BaseModel):
    success: bool = True


class OcrPreviewResponse(BaseModel):
    status: str  # queued | done | error | not_found
    message: str = ""
    nationality: str = ""
    passport_no: str = ""
    sex: str = ""
    pe_name: str = ""
    typhoon_name: str = ""
    remark: str = ""


class PhotoResponse(BaseModel):
    photo_type: str
    url: str
    ocr_queued: bool = False
