"""FastAPI 進入點 —— 本機小型網頁伺服器 + 瀏覽器操作。

服務埠 localhost:4141(避開 odoo-v2 的 3939)。啟動時自動開瀏覽器。
全中文、引導式;使用者不需寫任何程式或 SQL。

含:多人帳號與權限、單筆/多廠商彙總產出、交件追蹤、數字驗算、
上期帶入、範本改版、PDF 匯出與歸檔。
"""
from __future__ import annotations

import json
import shutil
import threading
import webbrowser
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.sessions import SessionMiddleware

from . import aggregate, auth, db, identify, mapping, pdf_export, report, validate
from .base_paths import (
    APP_DIR,
    OUTPUT_DIR,
    REPORT_TEMPLATES_DIR,
    UPLOADS_DIR,
    ensure_dirs,
    get_session_secret,
)
from .parsers import ParseError
from .parsers import parse as parse_source

PORT = 4141

# 不需登入即可存取的路徑
PUBLIC_PATHS = {"/login", "/logout"}

app = FastAPI(title="PMIS 營造廠商報表系統")
templates = Jinja2Templates(directory=str(APP_DIR / "templates"))
app.mount("/static", StaticFiles(directory=str(APP_DIR / "static")), name="static")


@app.on_event("startup")
def _startup() -> None:
    ensure_dirs()
    db.init_db()
    auth.ensure_default_admin()


# --- 認證 middleware:未登入一律導向登入頁 -----------------------------
# 用純 ASGI middleware(非 BaseHTTPMiddleware)以避免其在轉址時吃掉請求 body 的問題。
# 註冊順序:SessionMiddleware 必須最外層(最後加入),AuthGate 才讀得到 scope["session"]。

class AuthGateMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        path = scope.get("path", "")
        if path in PUBLIC_PATHS or path.startswith("/static"):
            return await self.app(scope, receive, send)
        session = scope.get("session") or {}
        if not session.get("user_id"):
            response = RedirectResponse("/login", status_code=303)
            return await response(scope, receive, send)
        return await self.app(scope, receive, send)


app.add_middleware(AuthGateMiddleware)  # 內層
app.add_middleware(SessionMiddleware, secret_key=get_session_secret(), max_age=8 * 3600)  # 外層


# --- 共用工具 ------------------------------------------------------------

def _current_user(request: Request) -> dict[str, Any] | None:
    uid = request.session.get("user_id")
    if not uid:
        return None
    user = db.get_user(uid)
    if not user or not user["active"]:
        return None
    return user


def _ensure_cap(request: Request, capability: str) -> dict[str, Any]:
    user = _current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="請先登入")
    if not auth.has_capability(user, capability):
        raise HTTPException(status_code=403, detail="您沒有使用此功能的權限,請聯絡系統管理者。")
    return user


def _save_upload(upload: UploadFile, dest_dir: Path) -> Path:
    dest_dir.mkdir(parents=True, exist_ok=True)
    filename = Path(upload.filename or "uploaded").name
    dest = dest_dir / filename
    with dest.open("wb") as f:
        shutil.copyfileobj(upload.file, f)
    return dest


def _render(request: Request, name: str, **ctx: Any) -> HTMLResponse:
    user = _current_user(request)
    ctx["request"] = request
    ctx["current_user"] = user
    ctx["caps"] = auth.capabilities_of(user) if user else set()
    return templates.TemplateResponse(name, ctx)


@app.exception_handler(403)
async def forbidden_handler(request: Request, exc: HTTPException):
    return _render(request, "forbidden.html", message=exc.detail)


@app.exception_handler(401)
async def unauthorized_handler(request: Request, exc: HTTPException):
    return RedirectResponse("/login", status_code=303)


# --- 登入 / 登出 ---------------------------------------------------------

@app.get("/login", response_class=HTMLResponse)
def login_page(request: Request, error: str = "") -> HTMLResponse:
    if request.session.get("user_id"):
        return RedirectResponse("/", status_code=303)
    return _render(request, "login.html", error=error)


@app.post("/login")
def login(request: Request, username: str = Form(...), password: str = Form(...)):
    user = auth.authenticate(username.strip(), password)
    if not user:
        return RedirectResponse("/login?error=帳號或密碼錯誤,或帳號已停用", status_code=303)
    request.session["user_id"] = user["id"]
    return RedirectResponse("/", status_code=303)


@app.get("/logout")
def logout(request: Request):
    request.session.clear()
    return RedirectResponse("/login", status_code=303)


# --- 首頁 ----------------------------------------------------------------

@app.get("/", response_class=HTMLResponse)
def home(request: Request) -> HTMLResponse:
    return _render(
        request,
        "home.html",
        reports=db.list_reports(),
        outputs=db.list_outputs()[:20],
    )


# --- 廠商管理 ------------------------------------------------------------

@app.get("/vendors", response_class=HTMLResponse)
def vendors_page(request: Request) -> HTMLResponse:
    _ensure_cap(request, "manage_vendors")
    vendors = db.list_vendors()
    for v in vendors:
        v["signatures"] = db.list_signatures(v["id"])
    return _render(request, "vendors.html", vendors=vendors)


@app.post("/vendors")
def create_vendor(request: Request, name: str = Form(...), tax_id: str = Form(""), note: str = Form("")):
    _ensure_cap(request, "manage_vendors")
    if name.strip():
        db.create_vendor(name.strip(), tax_id.strip(), note.strip())
    return RedirectResponse("/vendors", status_code=303)


@app.post("/vendors/{vendor_id}/delete")
def delete_vendor(request: Request, vendor_id: int):
    _ensure_cap(request, "manage_vendors")
    db.delete_vendor(vendor_id)
    return RedirectResponse("/vendors", status_code=303)


@app.post("/vendors/{vendor_id}/signatures")
def add_signature(request: Request, vendor_id: int, rule_type: str = Form(...), rule_value: str = Form(...)):
    _ensure_cap(request, "manage_vendors")
    if rule_value.strip():
        db.add_signature(vendor_id, rule_type, rule_value.strip())
    return RedirectResponse("/vendors", status_code=303)


@app.post("/signatures/{signature_id}/delete")
def delete_signature(request: Request, signature_id: int):
    _ensure_cap(request, "manage_vendors")
    db.delete_signature(signature_id)
    return RedirectResponse("/vendors", status_code=303)


# --- 報表管理(範本上傳/改版、欄位角色、應交廠商)---------------------

@app.get("/reports", response_class=HTMLResponse)
def reports_page(request: Request, error: str = "") -> HTMLResponse:
    _ensure_cap(request, "manage_reports")
    reports = db.list_reports()
    all_vendors = db.list_vendors()
    for r in reports:
        r["fields"] = db.list_report_fields(r["id"])
        r["versions"] = db.list_template_versions(r["id"])
        r["expected_vendor_ids"] = db.list_report_vendors(r["id"])
    return _render(request, "reports.html", reports=reports, all_vendors=all_vendors, error=error)


def _template_type_of(path: Path) -> str | None:
    ext = path.suffix.lower()
    if ext in (".xlsx", ".xlsm"):
        return "excel"
    if ext == ".docx":
        return "word"
    return None


@app.post("/reports")
def create_report(request: Request, name: str = Form(...), template: UploadFile = None):
    _ensure_cap(request, "manage_reports")
    name = name.strip()
    if not name:
        return RedirectResponse("/reports?error=請填寫報表名稱", status_code=303)
    if template is None or not template.filename:
        return RedirectResponse("/reports?error=請上傳報表範本檔", status_code=303)

    saved = _save_upload(template, REPORT_TEMPLATES_DIR)
    template_type = _template_type_of(saved)
    if template_type is None:
        saved.unlink(missing_ok=True)
        return RedirectResponse(
            "/reports?error=報表範本僅支援 Excel(.xlsx)或 Word(.docx)", status_code=303
        )
    try:
        fields = report.extract_fields(saved, template_type)
    except ParseError as exc:
        saved.unlink(missing_ok=True)
        return RedirectResponse(f"/reports?error={exc}", status_code=303)

    report_id = db.create_report(name, str(saved), template_type)
    db.set_report_fields(report_id, fields)
    return RedirectResponse("/reports", status_code=303)


@app.post("/reports/{report_id}/update-template")
def update_report_template(request: Request, report_id: int, template: UploadFile = None):
    """上傳新範本 → 版本 +1,保留舊版(功能 6)。"""
    _ensure_cap(request, "manage_reports")
    if template is None or not template.filename:
        return RedirectResponse("/reports?error=請選擇新的範本檔", status_code=303)
    saved = _save_upload(template, REPORT_TEMPLATES_DIR / f"r{report_id}_versions")
    template_type = _template_type_of(saved)
    if template_type is None:
        saved.unlink(missing_ok=True)
        return RedirectResponse("/reports?error=範本僅支援 Excel 或 Word", status_code=303)
    try:
        fields = report.extract_fields(saved, template_type)
    except ParseError as exc:
        saved.unlink(missing_ok=True)
        return RedirectResponse(f"/reports?error={exc}", status_code=303)

    db.update_report_template(report_id, str(saved), template_type)
    db.set_report_fields(report_id, fields)
    return RedirectResponse("/reports", status_code=303)


@app.post("/reports/{report_id}/expected-vendors")
async def set_expected_vendors(request: Request, report_id: int):
    _ensure_cap(request, "manage_reports")
    form = await request.form()
    vendor_ids = [int(v) for v in form.getlist("vendor_id")]
    db.set_report_vendors(report_id, vendor_ids)
    return RedirectResponse("/reports", status_code=303)


@app.post("/reports/{report_id}/roles")
async def set_roles(request: Request, report_id: int):
    _ensure_cap(request, "manage_reports")
    form = await request.form()
    amount_fields = set(form.getlist("amount_field"))
    all_fields = db.list_report_fields(report_id)
    roles = {
        f["field_name"]: ("amount" if f["field_name"] in amount_fields else "normal")
        for f in all_fields
    }
    db.set_field_roles(report_id, roles)
    return RedirectResponse("/reports", status_code=303)


@app.post("/reports/{report_id}/delete")
def delete_report(request: Request, report_id: int):
    _ensure_cap(request, "manage_reports")
    db.delete_report(report_id)
    return RedirectResponse("/reports", status_code=303)


# --- 對應設定 ------------------------------------------------------------

@app.get("/mapping", response_class=HTMLResponse)
def mapping_page(request: Request, vendor_id: int = 0, report_id: int = 0) -> HTMLResponse:
    _ensure_cap(request, "manage_mappings")
    vendors = db.list_vendors()
    reports = db.list_reports()
    context: dict[str, Any] = {
        "vendors": vendors, "reports": reports,
        "vendor_id": vendor_id, "report_id": report_id,
        "rows": None, "report_name": "", "vendor_name": "",
        "source_fields": [], "has_source": False,
    }
    if vendor_id and report_id:
        vt = db.get_vendor_template(vendor_id, report_id)
        report_fields = [f["field_name"] for f in db.list_report_fields(report_id)]
        vendor = db.get_vendor(vendor_id)
        rpt = db.get_report(report_id)
        context["vendor_name"] = vendor["name"] if vendor else ""
        context["report_name"] = rpt["name"] if rpt else ""
        source_fields = [f["field_name"] for f in db.list_source_fields(vt["id"])] if vt else []
        existing = db.list_mappings(vendor_id, report_id)
        if existing:
            rows = [
                {"report_field": m["report_field"],
                 "source_field": m.get("source_field") or "",
                 "auto": bool(m.get("source_field"))}
                for m in existing
            ]
        else:
            rows = mapping.suggest(source_fields, report_fields)["suggestions"]
        context.update(rows=rows, source_fields=source_fields, has_source=vt is not None)
    return _render(request, "mapping.html", **context)


@app.post("/mapping/upload-source")
async def mapping_upload_source(
    request: Request, vendor_id: int = Form(...), report_id: int = Form(...), source: UploadFile = None
):
    _ensure_cap(request, "manage_mappings")
    if source is None or not source.filename:
        return RedirectResponse(f"/mapping?vendor_id={vendor_id}&report_id={report_id}", status_code=303)
    saved = _save_upload(source, UPLOADS_DIR / f"v{vendor_id}_r{report_id}")
    try:
        parsed = parse_source(saved)
    except ParseError as exc:
        return RedirectResponse(
            f"/mapping?vendor_id={vendor_id}&report_id={report_id}&error={exc}", status_code=303
        )
    vt_id = db.create_vendor_template(vendor_id, report_id, saved.name, parsed.source_type)
    db.set_source_fields(
        vt_id,
        [{"field_name": f, "sample_value": parsed.sample_value(f), "location": ""} for f in parsed.fields],
    )
    return RedirectResponse(f"/mapping?vendor_id={vendor_id}&report_id={report_id}", status_code=303)


@app.post("/mapping/save")
async def mapping_save(request: Request):
    _ensure_cap(request, "manage_mappings")
    form = await request.form()
    vendor_id = int(form["vendor_id"])
    report_id = int(form["report_id"])
    pairs = [
        {"report_field": key[len("map__"):], "source_field": value}
        for key, value in form.items() if key.startswith("map__")
    ]
    mapping.save_mappings(vendor_id, report_id, pairs)
    return RedirectResponse(f"/mapping?vendor_id={vendor_id}&report_id={report_id}&saved=1", status_code=303)


# --- 日常產出(單筆)----------------------------------------------------

@app.post("/process", response_class=HTMLResponse)
async def process(
    request: Request,
    report_id: int = Form(...),
    source: UploadFile = None,
    period: str = Form(""),
    carry_over: str = Form(""),
    make_pdf: str = Form(""),
):
    _ensure_cap(request, "produce_reports")
    rpt = db.get_report(report_id)
    if rpt is None:
        return _render(request, "result.html", error="找不到指定的報表。", report_id=report_id)
    if source is None or not source.filename:
        return _render(request, "result.html", error="請選擇要上傳的廠商檔案。", report_id=report_id)

    saved = _save_upload(source, UPLOADS_DIR / "incoming")
    try:
        parsed = parse_source(saved)
    except ParseError as exc:
        db.create_output(report_id, None, saved.name, "", "error", str(exc), period=period)
        return _render(request, "result.html", error=str(exc), report_id=report_id)

    ident = identify.identify(parsed, saved.name)
    opts = {"period": period, "carry_over": bool(carry_over), "make_pdf": bool(make_pdf)}
    if ident.status != "matched":
        candidates = [db.get_vendor(v) for v in ident.candidates] if ident.candidates else db.list_vendors()
        candidates = [c for c in candidates if c]
        return _render(
            request, "confirm_vendor.html",
            reason=ident.reason, candidates=candidates,
            report_id=report_id, source_name=saved.name, opts=opts,
        )
    return _do_generate(request, report_id, ident.vendor_id, saved, parsed, opts)


@app.post("/process/confirmed", response_class=HTMLResponse)
async def process_confirmed(
    request: Request,
    report_id: int = Form(...),
    vendor_id: int = Form(...),
    source_name: str = Form(...),
    period: str = Form(""),
    carry_over: str = Form(""),
    make_pdf: str = Form(""),
):
    _ensure_cap(request, "produce_reports")
    saved = UPLOADS_DIR / "incoming" / source_name
    if not saved.exists():
        return _render(request, "result.html", error="來源檔已遺失,請重新上傳。", report_id=report_id)
    try:
        parsed = parse_source(saved)
    except ParseError as exc:
        return _render(request, "result.html", error=str(exc), report_id=report_id)
    opts = {"period": period, "carry_over": bool(carry_over), "make_pdf": bool(make_pdf)}
    return _do_generate(request, report_id, vendor_id, saved, parsed, opts)


def _safe(name: str) -> str:
    return name.replace("/", "_").replace("\\", "_").replace(":", "_")


def _do_generate(request: Request, report_id: int, vendor_id: int, source_path: Path, parsed, opts: dict) -> HTMLResponse:
    rpt = db.get_report(report_id)
    vendor = db.get_vendor(vendor_id)
    report_fields = db.list_report_fields(report_id)
    mappings = db.list_mappings(vendor_id, report_id)
    period = opts.get("period", "")

    if not mappings:
        msg = (f"廠商「{vendor['name'] if vendor else vendor_id}」尚未設定與此報表的對應,"
               "請先到「對應設定」完成後再產出。")
        db.create_output(report_id, vendor_id, source_path.name, "", "error", msg, period=period)
        return _render(request, "result.html", error=msg, report_id=report_id)

    unmapped = [m["report_field"] for m in mappings if not m.get("source_field")]
    carry = db.latest_output_values(report_id, vendor_id) if opts.get("carry_over") else {}

    ext = ".xlsx" if rpt["template_type"] == "excel" else ".docx"
    stamp = db.now().replace(":", "").replace("-", "").replace(" ", "_")
    period_tag = f"_{_safe(period)}" if period else ""
    output_filename = f"{_safe(rpt['name'])}_{_safe(vendor['name'] if vendor else str(vendor_id))}{period_tag}_{stamp}{ext}"

    try:
        result = report.generate(
            template_path=rpt["template_path"], template_type=rpt["template_type"],
            report_fields=report_fields, mappings=mappings,
            source_rows=parsed.rows, output_filename=output_filename, carry_over=carry,
        )
    except ParseError as exc:
        db.create_output(report_id, vendor_id, source_path.name, "", "error", str(exc), period=period)
        return _render(request, "result.html", error=str(exc), report_id=report_id)

    warnings = list(result["warnings"])
    if unmapped:
        warnings.insert(0, "以下報表欄位尚未設定對應來源(已留空):" + "、".join(unmapped))

    # 數字驗算:金額欄逐列加總(單筆多列時)提供對照
    amount_fields = [f["field_name"] for f in report_fields if f.get("field_role") == "amount"]
    if amount_fields and len(parsed.rows) > 1:
        totals = validate.column_totals(result_rows_for_validate(report_fields, mappings, parsed.rows), amount_fields)
        for fn, tot in totals.items():
            warnings.append(f"金額欄「{fn}」逐列加總 = {validate.format_amount(tot)}(含稅 {validate.format_amount(tot + validate.tax_of(tot))})。")

    status = "warning" if warnings else "ok"
    out_id = db.create_output(
        report_id, vendor_id, source_path.name, result["output_path"], status,
        "\n".join(warnings), period=period, template_version=rpt.get("version"),
        values_json=json.dumps(result["values"], ensure_ascii=False), kind="single",
    )
    if period:
        db.record_submission(report_id, vendor_id, period, out_id)

    pdf_note = _maybe_pdf(out_id, result["output_path"], opts.get("make_pdf"))

    return _render(
        request, "result.html", error="", report_id=report_id,
        vendor_name=vendor["name"] if vendor else str(vendor_id), report_name=rpt["name"],
        output_path=result["output_path"], output_id=out_id, warnings=warnings, pdf_note=pdf_note,
    )


def result_rows_for_validate(report_fields, mappings, source_rows):
    """把來源列換算成 報表欄位→值(供驗算加總),不寫檔。"""
    rf_to_sf = {m["report_field"]: (m.get("source_field") or "") for m in mappings}
    out = []
    for row in source_rows:
        out.append({f["field_name"]: row.get(rf_to_sf.get(f["field_name"], ""), "") for f in report_fields})
    return out


def _maybe_pdf(output_id: int, output_path: str, make_pdf: Any) -> str:
    if not make_pdf:
        return ""
    try:
        pdf_path = pdf_export.to_pdf(output_path)
        db.set_output_pdf(output_id, pdf_path)
        return "已同時產出 PDF。"
    except pdf_export.PdfExportError as exc:
        return str(exc)


# --- 多廠商彙總產出 ------------------------------------------------------

@app.get("/summary", response_class=HTMLResponse)
def summary_page(request: Request) -> HTMLResponse:
    _ensure_cap(request, "produce_reports")
    return _render(request, "summary.html", reports=db.list_reports())


@app.post("/summary/process", response_class=HTMLResponse)
async def summary_process(request: Request):
    _ensure_cap(request, "produce_reports")
    form = await request.form()
    report_id = int(form["report_id"])
    period = str(form.get("period", "")).strip()
    make_pdf = bool(form.get("make_pdf"))
    files = form.getlist("sources")

    rpt = db.get_report(report_id)
    if rpt is None:
        return _render(request, "result.html", error="找不到報表。", report_id=report_id)
    report_fields = db.list_report_fields(report_id)

    vendor_entries: list[dict[str, Any]] = []
    skipped: list[str] = []
    included_vendor_ids: list[int] = []

    for up in files:
        if not getattr(up, "filename", ""):
            continue
        saved = _save_upload(up, UPLOADS_DIR / "summary_incoming")
        try:
            parsed = parse_source(saved)
        except ParseError as exc:
            skipped.append(f"{saved.name}:{exc}")
            continue
        ident = identify.identify(parsed, saved.name)
        if ident.status != "matched":
            skipped.append(f"{saved.name}:{ident.reason}")
            continue
        vendor_id = ident.vendor_id
        mappings = db.list_mappings(vendor_id, report_id)
        if not mappings:
            v = db.get_vendor(vendor_id)
            skipped.append(f"{saved.name}:廠商「{v['name'] if v else vendor_id}」尚未設定對應。")
            continue
        values = result_rows_for_validate(report_fields, mappings, parsed.rows)
        entry_values = values[0] if values else {}
        vendor = db.get_vendor(vendor_id)
        vendor_entries.append({"vendor_name": vendor["name"] if vendor else str(vendor_id), "values": entry_values})
        included_vendor_ids.append(vendor_id)

    if not vendor_entries:
        return _render(
            request, "result.html",
            error="沒有任何檔案成功辨識並產出。" + ("問題:" + "；".join(skipped) if skipped else ""),
            report_id=report_id,
        )

    stamp = db.now().replace(":", "").replace("-", "").replace(" ", "_")
    period_tag = f"_{_safe(period)}" if period else ""
    output_filename = f"{_safe(rpt['name'])}_彙總{period_tag}_{stamp}.xlsx"
    try:
        result = aggregate.generate_summary(
            rpt["template_path"], report_fields, vendor_entries, output_filename
        )
    except ParseError as exc:
        return _render(request, "result.html", error=str(exc), report_id=report_id)

    warnings = list(result["warnings"])
    warnings.insert(0, f"已彙總 {len(vendor_entries)} 家廠商。")
    if skipped:
        warnings.append("以下檔案未納入:" + "；".join(skipped))

    out_id = db.create_output(
        report_id, None, f"彙總 {len(vendor_entries)} 家", result["output_path"], "warning",
        "\n".join(warnings), period=period, template_version=rpt.get("version"), kind="summary",
    )
    if period:
        for vid in included_vendor_ids:
            db.record_submission(report_id, vid, period, out_id)

    pdf_note = _maybe_pdf(out_id, result["output_path"], make_pdf)

    return _render(
        request, "result.html", error="", report_id=report_id,
        vendor_name=f"{len(vendor_entries)} 家廠商", report_name=rpt["name"] + "(彙總總表)",
        output_path=result["output_path"], output_id=out_id, warnings=warnings, pdf_note=pdf_note,
    )


# --- 交件追蹤 ------------------------------------------------------------

@app.get("/tracking", response_class=HTMLResponse)
def tracking_page(request: Request, report_id: int = 0, period: str = "") -> HTMLResponse:
    _ensure_cap(request, "manage_tracking")
    reports = db.list_reports()
    rows = None
    report_name = ""
    if report_id and period:
        rpt = db.get_report(report_id)
        report_name = rpt["name"] if rpt else ""
        expected_ids = db.list_report_vendors(report_id)
        submissions = {s["vendor_id"]: s for s in db.list_submissions(report_id, period)}
        rows = []
        for vid in expected_ids:
            v = db.get_vendor(vid)
            sub = submissions.get(vid)
            rows.append({
                "vendor_name": v["name"] if v else str(vid),
                "submitted": sub is not None,
                "updated_at": sub["updated_at"] if sub else "",
            })
    return _render(
        request, "tracking.html",
        reports=reports, report_id=report_id, period=period, rows=rows, report_name=report_name,
    )


# --- 產出記錄與下載 ------------------------------------------------------

@app.get("/outputs", response_class=HTMLResponse)
def outputs_page(request: Request) -> HTMLResponse:
    _ensure_cap(request, "view_outputs")
    outputs = db.list_outputs()
    for o in outputs:
        v = db.get_vendor(o["vendor_id"]) if o["vendor_id"] else None
        r = db.get_report(o["report_id"])
        o["vendor_name"] = v["name"] if v else ("(彙總)" if o.get("kind") == "summary" else "(未辨識)")
        o["report_name"] = r["name"] if r else "(已刪除)"
    return _render(request, "outputs.html", outputs=outputs)


@app.post("/outputs/{output_id}/pdf")
def make_output_pdf(request: Request, output_id: int):
    _ensure_cap(request, "view_outputs")
    o = db.get_output(output_id)
    if o and o["output_path"]:
        _maybe_pdf(output_id, o["output_path"], True)
    return RedirectResponse("/outputs", status_code=303)


@app.get("/download/{output_id}")
def download(request: Request, output_id: int):
    _ensure_cap(request, "view_outputs")
    o = db.get_output(output_id)
    if o and o["output_path"]:
        path = Path(o["output_path"])
        if path.exists():
            return FileResponse(path, filename=path.name)
    return RedirectResponse("/outputs", status_code=303)


@app.get("/download-pdf/{output_id}")
def download_pdf(request: Request, output_id: int):
    _ensure_cap(request, "view_outputs")
    o = db.get_output(output_id)
    if o and o.get("pdf_path"):
        path = Path(o["pdf_path"])
        if path.exists():
            return FileResponse(path, filename=path.name)
    return RedirectResponse("/outputs", status_code=303)


# --- 使用者與權限管理(僅 admin)---------------------------------------

@app.get("/users", response_class=HTMLResponse)
def users_page(request: Request, error: str = "", info: str = "") -> HTMLResponse:
    _ensure_cap(request, "manage_users")
    users = db.list_users()
    for u in users:
        u["perms"] = auth.capabilities_of(u)
    return _render(request, "users.html", users=users, capabilities=auth.CAPABILITIES, error=error, info=info)


@app.post("/users")
async def create_user(request: Request):
    _ensure_cap(request, "manage_users")
    form = await request.form()
    username = str(form.get("username", "")).strip()
    display_name = str(form.get("display_name", "")).strip()
    password = str(form.get("password", ""))
    role = "admin" if form.get("role") == "admin" else "staff"
    if not username or not password:
        return RedirectResponse("/users?error=請填寫帳號與密碼", status_code=303)
    if db.get_user_by_username(username):
        return RedirectResponse("/users?error=此帳號已存在", status_code=303)
    uid = db.create_user(username, display_name or username, auth.hash_password(password), role)
    caps = [c for c in form.getlist("capability") if c in auth.CAPABILITY_KEYS]
    db.set_user_permissions(uid, caps)
    return RedirectResponse("/users?info=已建立使用者", status_code=303)


@app.post("/users/{user_id}/permissions")
async def update_permissions(request: Request, user_id: int):
    _ensure_cap(request, "manage_users")
    form = await request.form()
    caps = [c for c in form.getlist("capability") if c in auth.CAPABILITY_KEYS]
    db.set_user_permissions(user_id, caps)
    return RedirectResponse("/users?info=權限已更新", status_code=303)


@app.post("/users/{user_id}/toggle")
def toggle_user(request: Request, user_id: int):
    admin = _ensure_cap(request, "manage_users")
    if user_id == admin["id"]:
        return RedirectResponse("/users?error=不能停用自己的帳號", status_code=303)
    u = db.get_user(user_id)
    if u:
        db.set_user_active(user_id, not u["active"])
    return RedirectResponse("/users", status_code=303)


@app.post("/users/{user_id}/reset-password")
async def reset_password(request: Request, user_id: int):
    _ensure_cap(request, "manage_users")
    form = await request.form()
    password = str(form.get("password", ""))
    if not password:
        return RedirectResponse("/users?error=請輸入新密碼", status_code=303)
    db.set_user_password(user_id, auth.hash_password(password))
    return RedirectResponse("/users?info=密碼已重設", status_code=303)


@app.post("/users/{user_id}/delete")
def delete_user(request: Request, user_id: int):
    admin = _ensure_cap(request, "manage_users")
    if user_id == admin["id"]:
        return RedirectResponse("/users?error=不能刪除自己的帳號", status_code=303)
    db.delete_user(user_id)
    return RedirectResponse("/users", status_code=303)


# --- 啟動器 --------------------------------------------------------------

def _open_browser() -> None:
    webbrowser.open(f"http://localhost:{PORT}/")


def run() -> None:
    import uvicorn

    threading.Timer(1.5, _open_browser).start()
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info")


if __name__ == "__main__":
    run()
