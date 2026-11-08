"""Export projection of app.js daily demo seed (verified against the browser).

Only synthetic defaults live here. Saved records always override this projection.
"""
import json
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

FRONTEND = Path(__file__).resolve().parent.parent / 'web'
SEOUL = ZoneInfo('Asia/Seoul')


def parsed(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(SEOUL)


def demo_records(day):
    payload = json.loads((FRONTEND / 'data/farmingboy_customers_100.json').read_text())
    # The catalog is a JSON array exported by the existing vanilla JS module.
    catalog = json.loads((FRONTEND / 'parts-catalog.js').read_text().split('export const defaultCatalog = ', 1)[1].rstrip(';\n'))
    midnight = parsed(day + 'T00:00:00+09:00')
    offset = midnight - parsed(payload['_meta']['base_date'] + 'T00:00:00+09:00')
    customers = payload['customers']
    for c in customers:
        for key in ('received_at', 'arrived_at', 'completed_at'):
            if c.get('current_job', {}).get(key):
                c['current_job'][key] = (parsed(c['current_job'][key]) + offset).isoformat()
    ordered = sorted((c for c in customers if c['current_job']['received_at'][:10] != day), key=lambda c: c['current_job']['received_at'], reverse=True)
    recent = [c for c in ordered if midnight - parsed(c['current_job']['received_at']) <= timedelta(days=7)][:6]
    recent_ids = {c['customer_id'] for c in recent}
    dispatched = (recent + [c for c in ordered if c['customer_id'] not in recent_ids])[:12]
    assigned = {c['customer_id']: '엔지니어 ' + 'ABC'[i // 4] for i, c in enumerate(dispatched)}
    times = {dispatched[i]['customer_id']: t for i, t in zip([0, 1, 4, 5, 8], ['09:18:00', '10:32:00', '09:41:00', '11:06:00', '10:14:00'])}
    pending = {c['customer_id'] for c in dispatched} - times.keys()
    assigned.update({c['customer_id']: '엔지니어 ' + 'ABC'[i % 3] for i, c in enumerate(c for c in customers if c['customer_id'] not in assigned)})
    rows = []
    for i, c in enumerate(customers):
        job, cid = c['current_job'], c['customer_id']
        if job['received_at'][:10] == day or cid in pending:
            continue
        minutes = [45, 60, 75, 90, 120, 150][i % 6]
        completed = parsed(day + 'T' + times[cid] + '+09:00') if cid in times else parsed(job.get('completed_at') or job['received_at'])
        if cid not in times and not job.get('completed_at'):
            completed += timedelta(minutes=minutes)
        arrived = completed - timedelta(minutes=minutes)
        part = catalog[i % len(catalog)]
        travel = [33000, 55000, 77000, 100000][i % 4]
        row = dict(id='FARMINGBOY-' + cid, demoDay=day, customerName=c['name'],
                   registeredAddress=c['address']['full'], dispatchAddress=c['address']['full'],
                   receivedAt=job['received_at'], completedAt=completed.isoformat(), arrivedAt=arrived.isoformat(),
                   stage='complete', assignedEngineer=assigned[cid], counselorName='상담사 ' + 'ABC'[i % 3],
                   erp={'productName': c['machine']['model'], 'purchaseDate': c['machine']['purchase_date']},
                   transcript=[{'role': 'counselor', 'text': job.get('request_text', '')}],
                   onsiteMinutes=minutes, repairNotes=f'합성 완료 기록 · {part["name"]} 교체 및 작동 재시험 완료',
                   repairPlan={'details': f'현장 점검 후 {part["name"]} 교체', 'parts': [{**part, 'qty': 1, 'unitPrice': part['retailPrice'] + part['laborPrice']}], 'travelFee': travel, 'distanceKm': [12, 42, 78, 120][i % 4]},
                   beforePhotos=[None] * (i % 3 + 1), afterPhotos=[None] * (i % 3 + 1),
                   approvalSignature={'typedName': c['name'], 'signedAt': (arrived + timedelta(minutes=int(minutes * .35 + .5))).isoformat()},
                   finalSignature={'typedName': c['name'], 'signedAt': completed.isoformat()})
        special = {
            'CUS-094': ('충전플러그', 'charging-before-after.png', 'top', '충전플러그의 열 손상과 접촉 불량을 확인해 교체했습니다. 체결 상태와 충전 연결을 재점검하고 정상 작동을 확인했습니다.'),
            'CUS-093': ('메인퓨즈 10 A', 'fuse-before-after.png', 'bottom', '메인퓨즈를 교체하고 전원 연결부를 점검했습니다. 라이트 점등과 경적 작동을 재시험해 정상 복구를 확인했습니다.')
        }.get(cid)
        if special:
            name, photo, band, notes = special
            part = next(p for p in catalog if p['name'] == name)
            row['repairPlan'].update(details=name + ' 교체 및 기능 재점검', parts=[{**part, 'qty': 1, 'unitPrice': part['retailPrice'] + part['laborPrice']}])
            row['repairNotes'] = notes
            row['demoEvidenceBoard'] = './assets/demo-repairs/' + photo
            row['beforePhotos'] = row['afterPhotos'] = [row['demoEvidenceBoard']]
            row['approvalSignature']['signedAt'] = (arrived + timedelta(minutes=10)).isoformat()
            for key in ('approvalSignature', 'finalSignature'):
                row[key].update(image='./assets/demo-repairs/signatures.png', demoBand=band)
        rows.append(row)
    return rows
