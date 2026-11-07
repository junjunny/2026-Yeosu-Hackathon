"""Read-only exports from the shared record snapshot. No customer files enter Git."""
import base64
import html
import io
import math
import re
from datetime import datetime
from urllib.parse import quote

from fastapi import HTTPException
from fastapi.responses import Response
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from weasyprint import HTML, default_url_fetcher

from .records import MEDIA, DEMO_MEDIA, today
from .report_demo import demo_records, parsed, FRONTEND, SEOUL


def completed_records(store):
    snapshot = store.snapshot()
    merged = {r['id']: r for r in demo_records(today())}
    merged.update({r['id']: r for r in snapshot['cases']})
    return sorted((r for r in merged.values() if r.get('stage') == 'complete'),
                  key=lambda r: (not r['id'].startswith('FARMINGBOY-'), stamp(r.get('completedAt')), r['id']))


def number(value):
    try:
        n = float(value)
        return n if math.isfinite(n) else 0
    except (TypeError, ValueError):
        return 0


def costs(record):
    plan = record.get('repairPlan') or {}
    subtotal = sum(number(p.get('qty')) * number(p.get('unitPrice')) for p in plan.get('parts', []))
    extra = number(plan.get('laborPrice') if plan.get('legacy') else plan.get('travelFee'))
    return subtotal, extra, subtotal + extra


def stamp(value):
    try:
        return parsed(value).strftime('%Y.%m.%d %H:%M')
    except (ValueError, TypeError, AttributeError):
        return '기록 없음'


def elapsed(record):
    try:
        return max(0, round((parsed(record['completedAt']) - parsed(record['arrivedAt'])).total_seconds() / 60))
    except (KeyError, ValueError, TypeError):
        return None


def download(content, filename, mime):
    return Response(content, media_type=mime, headers={
        'Content-Disposition': "attachment; filename*=UTF-8''" + quote(filename),
        'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'})


def excel_bytes(records):
    book = Workbook()
    history = book.active
    history.title = '누적 수리 이력'
    history.append(['접수 ID', '자료 구분', '고객명', '제품명', '현장 주소', '상담사', '담당 기사', '접수 시각 (한국)', '현장 도착', '수리 동의', '최종 서명', '완료 시각', '현장 경과(분)', '점검 결과', '실제 수리 결과', '부품·공임 합계(원)', '출장비·기타(원)', '견적 총액(원)', '비용 기준', '수리 전 사진(장)', '수리 후 사진(장)', '수리 동의 확인', '최종 확인'])
    parts = book.create_sheet('사용 부품 상세')
    parts.append(['접수 ID', '고객명', '부품명', '수량', '단가·공임 포함(원)', '합계(원)'])
    for r in records:
        p = r.get('repairPlan') or {}
        approval, final = r.get('approvalSignature') or {}, r.get('finalSignature') or {}
        synthetic = r['id'].startswith('FARMINGBOY-')
        history.append([r['id'], '합성 데모' if synthetic else '직접 접수', r.get('customerName'), (r.get('erp') or {}).get('productName', r.get('equipmentId')), r.get('dispatchAddress'), r.get('counselorName'), r.get('assignedEngineer'), stamp(r.get('receivedAt') or r.get('createdAt')), stamp(r.get('arrivedAt')), stamp(approval.get('signedAt')), stamp(final.get('signedAt')), stamp(r.get('completedAt')), elapsed(r), r.get('checklistFindings'), r.get('repairNotes'), *costs(r), '이전 견적: 출장비 확인 필요' if p.get('legacy') else '저장된 견적 · 수금 확인 아님' if p else '견적 기록 없음', len(r.get('beforePhotos') or []), len(r.get('afterPhotos') or []), '손글씨 서명' if approval.get('image') else '성명 확인' if approval else '기록 없음', '손글씨 서명' if final.get('image') else '성명 확인' if final else '기록 없음'])
        if not p:
            for col in (16, 17, 18):
                history.cell(history.max_row, col).value = None
        for part in p.get('parts', []):
            parts.append([r['id'], r.get('customerName'), part.get('name'), number(part.get('qty')), number(part.get('unitPrice')), number(part.get('qty')) * number(part.get('unitPrice'))])
    info = book.create_sheet('읽어 주세요')
    for row in [
        ['항목', '설명'], ['생성 시각 (한국)', datetime.now(SEOUL).strftime('%Y.%m.%d %H:%M:%S')],
        ['완료 건수', len(records)], ['데이터 원본', '서버 SQLite의 저장된 완료 기록 + 화면과 같은 합성 데모 기본 이력'],
        ['정렬', '기존 합성 고객 이력 다음에 직접 접수한 완료 고객을 완료 시각순으로 추가합니다. 접수 ID로 중복을 제거합니다.'],
        ['갱신', '다운로드할 때마다 최신 서버 기록으로 새 파일을 생성합니다. 이미 내려받은 파일은 자동 변경되지 않습니다.'],
        ['범위', '수리 완료 건만 포함합니다. 접수·검토·방문 예정·원격 안내 종료는 제외합니다. 화면의 조회 기간과 무관한 전체 완료 이력입니다.'],
        ['합성 자료', '기본 데모는 한국 날짜에 맞춰 최근 30일로 이동합니다. 직접 접수한 실제 기록은 날짜가 바뀌어도 유지됩니다.'],
        ['비용', '부품 단가는 공임을 포함합니다. 별도 공임을 중복 합산하지 않습니다. 견적은 입금·수금 확인서가 아닙니다.'],
        ['사진·서명', '원본은 서버 파일 저장소에 보관합니다. 고객별 PDF에서 저장된 사진·서명을 확인하세요. 엑셀에는 개수와 확인 방식만 표시합니다.'],
    ]:
        info.append(row)
    for sheet in book:
        sheet.freeze_panes = 'A2'
        sheet.auto_filter.ref = sheet.dimensions
        sheet.sheet_view.zoomScale = 85
        for row in sheet:
            for cell in row:
                if isinstance(cell.value, str):
                    # Never interpret customer-entered '=' strings as spreadsheet formulas.
                    cell.value = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', '', cell.value)
                    cell.data_type = 's'
                cell.font = Font(name='맑은 고딕', size=11, color='17273D')
                cell.alignment = Alignment(vertical='top', wrap_text=True)
                if cell.row == 1:
                    cell.fill = PatternFill('solid', fgColor='243F61')
                    cell.font = Font(name='맑은 고딕', size=11, bold=True, color='FFFFFF')
                elif cell.row % 2 == 0:
                    cell.fill = PatternFill('solid', fgColor='F0F5FA')
        for col in range(1, sheet.max_column + 1):
            sheet.column_dimensions[get_column_letter(col)].width = 23
        sheet.row_dimensions[1].height = 34
    for col in ('E', 'N', 'O'):
        history.column_dimensions[col].width = 48
    history.column_dimensions['A'].width = 43
    parts.column_dimensions['A'].width = 43
    parts.column_dimensions['C'].width = 36
    info.column_dimensions['B'].width = 105
    for row in history.iter_rows(min_row=2, min_col=16, max_col=18):
        for cell in row:
            cell.number_format = '#,##0'
    for row in parts.iter_rows(min_row=2, min_col=5, max_col=6):
        for cell in row:
            cell.number_format = '#,##0'
    output = io.BytesIO()
    book.save(output)
    return output.getvalue()


def image_uri(value, store):
    """Only hashed saved media or bundled synthetic evidence; never fetch user URLs."""
    if not isinstance(value, str):
        return None
    filename = value.rsplit('/', 1)[-1]
    path = None
    if value.startswith('./api/records/media/') and MEDIA.fullmatch(filename):
        path = store.media / filename
    elif value.startswith('./assets/demo-repairs/') and filename in DEMO_MEDIA:
        path = FRONTEND / 'assets/demo-repairs' / filename
    if not path or not path.is_file() or path.stat().st_size > 12_000_000:
        return None
    mime = {'.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp'}[path.suffix]
    return 'data:' + mime + ';base64,' + base64.b64encode(path.read_bytes()).decode()


def restricted_fetch(url, *args, **kwargs):
    if not url.startswith(('data:image/png;base64,', 'data:image/jpeg;base64,', 'data:image/webp;base64,')):
        raise ValueError('External report resources are disabled')
    return default_url_fetcher(url, *args, **kwargs)


def pdf_bytes(r, store):
    e = lambda value: html.escape(str(value or '기록 없음'))
    money = lambda value: f'{number(value):,.0f}원'
    p = r.get('repairPlan') or {}
    synthetic = r['id'].startswith('FARMINGBOY-')
    subtotal, extra, total = costs(r)
    symptom = '\n'.join(str(t.get('text', '')) for t in r.get('transcript', []) if t.get('role') == 'counselor')
    # Keep customer report scoped to confirmed work, not internal AI conversations.
    facts = [('고객', r.get('customerName')), ('제품', (r.get('erp') or {}).get('productName') or r.get('equipmentId')), ('방문 주소', r.get('dispatchAddress')), ('담당 기사', r.get('assignedEngineer')), ('수리 완료', stamp(r.get('completedAt')))]
    sections = ''.join(f'<section><h2>{title}</h2><p>{e(value)}</p></section>' for title, value in [('접수한 증상', symptom), ('현장 점검 결과', r.get('checklistFindings')), ('수리 내용과 확인 결과', r.get('repairNotes'))])
    rows = ''.join(f'<tr><td>{e(part.get("name"))}</td><td>{number(part.get("qty")):g}</td><td>{money(part.get("unitPrice"))}</td><td>{money(number(part.get("qty")) * number(part.get("unitPrice")))}</td></tr>' for part in p.get('parts', []))
    signs = ''
    for key, title in [('approvalSignature', '수리 진행 동의'), ('finalSignature', '수리 이행 확인')]:
        sign = r.get(key) or {}
        uri = image_uri(sign.get('image'), store)
        if uri and sign.get('demoBand') in ('top', 'bottom'):
            picture = f'<div class="signature sample" style="background-image:url({uri});background-position:center {sign["demoBand"]}"></div>'
        else:
            picture = f'<img class="signature" src="{uri}" alt="저장된 손글씨 서명">' if uri else '<p class="muted">손글씨 이미지 없음 · 저장된 성명 확인</p>'
        signs += f'<div class="sign"><h3>{title}</h3>{picture}<p>{e(sign.get("typedName"))}<br><small>{stamp(sign.get("signedAt"))}</small></p></div>'
    photos = ''
    groups = [('수리 전 · 후 비교', [r['demoEvidenceBoard']])] if r.get('demoEvidenceBoard') else [('수리 전 사진', r.get('beforePhotos') or []), ('수리 후 사진', r.get('afterPhotos') or [])]
    for title, values in groups:
        for start in range(0, len(values), 4):
            cards = ''
            for i, value in enumerate(values[start:start + 4], start + 1):
                uri = image_uri(value, store)
                picture = f'<img src="{uri}" alt="{title} {i}">' if uri else '<div class="missing">합성 사진 자리표시자</div>' if synthetic else '<div class="missing">사진 파일을 확인할 수 없습니다.</div>'
                cards += f'<figure class="{'wide' if len(values) == 1 else ''}">{picture}<figcaption>{title} {i}</figcaption></figure>'
            photos += f'<article class="page"><h1>{title}</h1><p class="muted">{e(r.get("customerName"))} · 저장된 현장 증빙{ " · 합성 데모 이미지" if synthetic else ""}</p><div class="photos">{cards}</div></article>'
    checks = (r.get('analysis') or {}).get('checklist') or []
    checked = r.get('checklistDone') or []
    checklist = ''.join(f'<li>{"확인 완료" if i in checked else "확인 기록 없음"} · {e(step)}</li>' for i, step in enumerate(checks))
    content = f'''<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>수리 완료 안내서</title><style>
    @page {{size:A4;margin:17mm 17mm 19mm;@bottom-left{{content:"Fieldnote · 수리 완료 안내서";font-size:9pt;color:#526077}}@bottom-right{{content:counter(page) " / " counter(pages);font-size:9pt;color:#526077}}}}
    body{{font-family:"Noto Sans CJK KR",sans-serif;font-size:13pt;line-height:1.65;color:#17273d;margin:0;word-wrap:break-word}}
    h1{{font-size:25pt;line-height:1.3;margin:4mm 0 5mm}}h2{{font-size:16pt;margin:0 0 2mm;color:#223e61}}h3{{font-size:13pt;margin:0}}
    p{{margin:0 0 3mm;white-space:pre-wrap}}small,.muted{{font-size:10pt;color:#516176}}.brand{{font-size:11pt;letter-spacing:2px;color:#3e5d88}}
    .tag{{padding:2mm 3mm;background:#edf2fa;font-size:10pt}}.facts{{background:#f1f5fa;padding:5mm;margin:5mm 0}}.fact{{margin:1mm 0}}.fact b{{display:inline-block;width:25mm}}
    section{{margin:6mm 0}}.total{{border-top:2px solid #345980;padding:4mm 0;margin-top:6mm;font-size:15pt}}.total strong{{float:right;font-size:23pt}}
    .page{{break-before:page}}table{{width:100%;border-collapse:collapse;table-layout:fixed;font-size:11pt;margin:5mm 0}}th,td{{padding:3mm 2mm;border-bottom:1px solid #dce3ec;text-align:right;overflow-wrap:anywhere}}th{{background:#edf2fa}}th:first-child,td:first-child{{text-align:left;width:36%}}th:nth-child(2){{width:9%}}thead{{display:table-header-group}}tr{{break-inside:avoid}}
    .signs{{display:flex;gap:6mm;margin:6mm 0;break-inside:avoid}}.sign{{width:50%;border:1px solid #dce3ec;padding:4mm;box-sizing:border-box}}.signature{{display:block;width:100%;height:25mm;object-fit:contain;margin:3mm 0}}.sample{{background-size:100% 200%;background-repeat:no-repeat}}
    .photos{{display:flex;flex-wrap:wrap;gap:5mm}}figure{{width:calc(50% - 3mm);margin:3mm 0;break-inside:avoid}}figure img,.missing{{width:100%;height:82mm;object-fit:contain;background:#f4f6f9}}.missing{{font-size:11pt;display:flex;align-items:center;justify-content:center}}figure.wide{{width:100%}}figure.wide img{{height:135mm}}figcaption{{font-size:11pt;margin-top:2mm}}ul{{padding-left:6mm;font-size:11pt}}
    </style></head><body><div class="brand">FIELDNOTE · 현장 서비스</div><h1>수리가 완료되었습니다</h1>
    <p class="tag">{'합성 데모 · 시연용 수리 기록' if synthetic else '고객용 수리 완료 안내서'}</p>
    <div class="facts">{''.join(f'<div class="fact"><b>{k}</b>{e(v)}</div>' for k, v in facts)}</div>{sections}
    <div class="total">견적 총액<strong>{money(total) if p else '기록 없음'}</strong></div><p class="muted">부품·공임 및 {'이전 작업비' if p.get('legacy') else '출장비'} 포함 · 수금 확인서는 아닙니다.</p>
    <article class="page"><h1>비용 및 고객 확인</h1><p>{e(p.get('details'))}</p>
    <table><thead><tr><th>사용 부품</th><th>수량</th><th>단가</th><th>금액</th></tr></thead><tbody>{rows or '<tr><td colspan="4">부품 기록 없음</td></tr>'}</tbody></table>
    <p>부품·공임 합계: {money(subtotal)}<br>{'이전 작업비' if p.get('legacy') else '출장비'}: {money(extra)}<br><b>견적 총액: {money(total) if p else '기록 없음'}</b></p>
    <p class="muted">부품 단가는 공임을 포함합니다. 별도 공임을 중복 합산하지 않았습니다.{' 이전 견적은 출장비 확인이 필요합니다.' if p.get('legacy') else ''}</p>
    <h2>현장 진행 기록</h2><p>현장 도착: {stamp(r.get('arrivedAt'))}<br>최종 완료: {stamp(r.get('completedAt'))}<br>현장 경과: {str(elapsed(r)) + '분' if elapsed(r) is not None else '기록 없음'}</p>
    <p class="muted">현장 경과에는 점검·대기·수리가 포함됩니다.</p><div class="signs">{signs}</div>
    {f'<h2>점검 체크리스트</h2><ul>{checklist}</ul>' if checklist else ''}
    <p class="muted">접수 번호: {e(r['id'])}<br>문서 생성: {datetime.now(SEOUL).strftime('%Y.%m.%d %H:%M')} (한국 시간)</p></article>{photos}</body></html>'''
    return HTML(string=content, url_fetcher=restricted_fetch).write_pdf()


def repair_pdf(store, case_id):
    record = next((r for r in completed_records(store) if r['id'] == case_id), None)
    if record is None:
        raise HTTPException(404, '서버에 저장된 수리 완료 기록을 찾을 수 없습니다. 저장 완료 후 다시 시도해 주세요.')
    name = re.sub(r'[^\w가-힣-]', '_', str(record.get('customerName') or '고객'))[:40]
    return download(pdf_bytes(record, store), f'수리완료_{name}_{today()}.pdf', 'application/pdf')
