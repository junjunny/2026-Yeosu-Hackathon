import io
import tempfile
import unittest
from copy import deepcopy
from unittest.mock import patch

from fastapi.testclient import TestClient
from openpyxl import load_workbook
from pypdf import PdfReader

from frontend.dispatch import app as service
from frontend.dispatch.records import RecordStore, today
from frontend.dispatch.reports import completed_records, demo_records, image_uri
from frontend.dispatch.tests.test_records import PNG


class ReportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = RecordStore(self.temp.name)
        self.patch = patch.object(service, 'record_store', self.store)
        self.patch.start()
        self.client = TestClient(service.app)

    def tearDown(self):
        self.client.close()
        self.patch.stop()
        self.temp.cleanup()

    def save(self, record, revision=0):
        response = self.client.post('/api/records/sync', json={'changes': [{'record': record, 'baseRevision': revision}]})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()['cases'][0]

    def actual(self, stage='complete'):
        return dict(id='REPORT-TEST-ONLY', customerName='합성 PDF 검증', stage=stage,
                    completedAt='2026-11-08T12:00:00+09:00', arrivedAt='2026-11-08T11:00:00+09:00',
                    dispatchAddress='전남 나주시 합성 검증 주소', assignedEngineer='엔지니어 A',
                    transcript=[{'role': 'counselor', 'text': '딱딱 소리가 나고, 브레이크가 밀리는 것 같다.'}],
                    erp={'productName': '파밍보이2.0A'}, checklistFindings='브레이크 및 앞 타이어 마모 확인',
                    repairNotes='브레이크 패드와 앞 타이어 2개 교체 후 정상 작동 확인',
                    repairPlan={'details': '브레이크와 앞 타이어 2개 교체', 'travelFee': 33000,
                                'parts': [{'name': '브레이크 패드', 'qty': 1, 'unitPrice': 20000}, {'name': '앞 타이어', 'qty': 2, 'unitPrice': 40000}]},
                    beforePhotos=[PNG] * 5, afterPhotos=[PNG] * 5,
                    approvalSignature={'typedName': '합성 검증', 'signedAt': '2026-11-08T11:15:00+09:00', 'image': PNG},
                    finalSignature={'typedName': '합성 검증', 'signedAt': '2026-11-08T12:00:00+09:00', 'image': PNG})

    def test_latest_excel_includes_new_completion_once_after_existing_history(self):
        initial = self.client.get('/api/reports/repairs.xlsx')
        base = load_workbook(io.BytesIO(initial.content)).active.max_row
        r = self.save(self.actual('final-verification'))
        self.assertEqual(len(completed_records(self.store)), base - 1)
        r['stage'] = 'complete'
        r['repairNotes'] = '=HYPERLINK("https://example.invalid")'
        saved = self.save(r, r['_serverRevision'])
        response = self.client.get('/api/reports/repairs.xlsx')
        self.assertIn('no-store', response.headers['cache-control'])
        self.assertIn("filename*=UTF-8''", response.headers['content-disposition'])
        workbook = load_workbook(io.BytesIO(response.content))
        sheet = workbook['누적 수리 이력']
        self.assertEqual(sheet.max_row, base + 1)
        self.assertEqual(sheet.cell(sheet.max_row, 1).value, r['id'])
        self.assertEqual(sheet.cell(sheet.max_row, 18).value, 133000)
        self.assertEqual(sheet.cell(sheet.max_row, 15).data_type, 's')
        self.assertEqual(sheet.cell(sheet.max_row, 13).value, 60)
        self.save(saved, saved['_serverRevision'])
        self.assertEqual(len(completed_records(self.store)), base)
        # A saved synthetic override replaces the same default rather than appending twice.
        demo = deepcopy(demo_records(today())[0])
        demo['beforePhotos'] = demo['afterPhotos'] = []
        demo['stage'] = 'awaiting-arrival'
        self.save(demo)
        self.assertEqual(len(completed_records(self.store)), base - 1)

    def test_pdf_has_korean_costs_all_photos_and_both_signatures(self):
        self.save(self.actual())
        response = self.client.get('/api/reports/repairs/REPORT-TEST-ONLY.pdf')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['content-type'], 'application/pdf')
        reader = PdfReader(io.BytesIO(response.content))
        text = '\n'.join(page.extract_text() for page in reader.pages)
        for expected in ['133,000원', '33,000원', '브레이크', '앞 타이어', '수리 전 사진 5', '수리 후 사진 5', '수리 진행 동의', '수리 이행 확인']:
            self.assertIn(expected, text)
        self.assertGreaterEqual(len(reader.pages), 6)
        self.assertLessEqual(len(reader.pages), 7)

    def test_pdf_missing_or_unfinished_is_not_exported_and_external_media_blocked(self):
        self.save(self.actual('customer-approval'))
        for ident in ['REPORT-TEST-ONLY', 'UNKNOWN']:
            self.assertEqual(self.client.get(f'/api/reports/repairs/{ident}.pdf').status_code, 404)
        for url in ['file:///etc/passwd', 'https://example.com/picture.png', 'data:image/svg+xml,<svg/>', './api/records/media/../../.env']:
            self.assertIsNone(image_uri(url, self.store))


if __name__ == '__main__':
    unittest.main()
