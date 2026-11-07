// Read .xlsx locally: ZIP central directory + XML. No workbook is uploaded.
async function workbookFiles(buffer) {
  const view = new DataView(buffer); const bytes = new Uint8Array(buffer);
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0 || view.getUint32(end, true) !== 0x06054b50) throw new Error('올바른 xlsx 파일이 아닙니다.');
  const count = view.getUint16(end + 10, true); let offset = view.getUint32(end + 16, true);
  const files = new Map(); const decoder = new TextDecoder(); let totalSize = 0;
  for (let i=0; i<count; i++) {
    if (view.getUint32(offset,true)!==0x02014b50) throw new Error('엑셀 압축 구조를 읽을 수 없습니다.');
    const flags=view.getUint16(offset+8,true), method=view.getUint16(offset+10,true);
    const size=view.getUint32(offset+20,true), rawSize=view.getUint32(offset+24,true);
    const nameLength=view.getUint16(offset+28,true), extra=view.getUint16(offset+30,true), comment=view.getUint16(offset+32,true);
    const local=view.getUint32(offset+42,true), name=decoder.decode(bytes.slice(offset+46,offset+46+nameLength));
    offset+=46+nameLength+extra+comment;
    if (!name.endsWith('.xml') && !name.endsWith('.rels')) continue;
    totalSize+=rawSize;
    if (flags&1 || rawSize>10000000 || totalSize>30000000) throw new Error('암호가 없고 압축 해제 후 30MB 이하인 가격표를 사용해 주세요.');
    if (view.getUint32(local,true)!==0x04034b50) throw new Error('엑셀 파일이 손상되었습니다.');
    const start=local+30+view.getUint16(local+26,true)+view.getUint16(local+28,true);
    const packed=bytes.slice(start,start+size);
    let data;
    if (method===0) data=packed;
    else if (method===8) data=new Uint8Array(await new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    else throw new Error('지원하지 않는 엑셀 압축 형식입니다.');
    if (data.byteLength !== rawSize) throw new Error('엑셀 파일 크기를 확인할 수 없습니다.');
    files.set(name,decoder.decode(data));
  }
  return files;
}
function xml(text) {
  const doc=new DOMParser().parseFromString(text||'', 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('엑셀 내용을 읽을 수 없습니다.');
  return doc;
}
export async function readPriceWorkbook(file) {
  if (!file || !/\.xlsx$/i.test(file.name) || file.size>10000000) throw new Error('10MB 이하의 .xlsx 가격표를 선택해 주세요.');
  const files=await workbookFiles(await file.arrayBuffer());
  const shared=files.has('xl/sharedStrings.xml') ? [...xml(files.get('xl/sharedStrings.xml')).querySelectorAll('si')].map(si=>[...si.querySelectorAll('t')].map(t=>t.textContent).join('')) : [];
  const book=xml(files.get('xl/workbook.xml')); const rels=xml(files.get('xl/_rels/workbook.xml.rels'));
  return [...book.querySelectorAll('sheet')].map(sheet=>{
    const id=sheet.getAttribute('r:id'); const rel=[...rels.querySelectorAll('Relationship')].find(r=>r.getAttribute('Id')===id);
    const target=rel?.getAttribute('Target')||''; const path=target.startsWith('/')?target.slice(1):`xl/${target.replace(/^\.\//,'')}`;
    if (!files.has(path)) throw new Error('가격표 시트를 찾을 수 없습니다.');
    const rows=[...xml(files.get(path)).querySelectorAll('sheetData row')].map(row=>{
      const values=[];
      for (const cell of row.querySelectorAll('c')) {
        const col=(cell.getAttribute('r')||'A1').replace(/\d/g,''); let index=0;
        for(const ch of col) index=index*26+ch.charCodeAt(0)-64;
        const value=cell.querySelector('v')?.textContent||'';
        values[index-1]=cell.getAttribute('t')==='s'?shared[Number(value)]||'':cell.getAttribute('t')==='inlineStr'?[...cell.querySelectorAll('t')].map(t=>t.textContent).join(''):value;
      }
      return values;
    }).filter(row=>row.some(v=>String(v).trim()));
    return { name:sheet.getAttribute('name'), rows };
  });
}

export function catalogFromRows(rows, { headerRow, nameColumn, retailColumn, laborColumn }) {
  const indexes=[nameColumn,retailColumn,laborColumn].map(Number);
  if (new Set(indexes).size!==3) throw new Error('부품명·소비자가·공임 열을 각각 선택해 주세요.');
  const money=value=>{
    const text=String(value??'').trim().replace(/[₩원,\s]/g,'');
    if (!/^\d+(?:\.0+)?$/.test(text)) throw new Error('빈 금액·수식 오류·문자는 가격으로 사용할 수 없습니다. 0원은 숫자 0으로 입력해 주세요.');
    const n=Number(text); if (!Number.isSafeInteger(n)||n<0) throw new Error('금액은 0 이상의 정수여야 합니다.'); return n;
  };
  const catalog=rows.slice(Number(headerRow)+1).filter(row=>row.some(v=>String(v??'').trim())).map((row,i)=>{
    const name=String(row[indexes[0]]??'').trim(); if(!name) throw new Error(`${i+1}번째 데이터 행의 부품명이 없습니다.`);
    return { id:`PART-${i+1}`,name,retailPrice:money(row[indexes[1]]),laborPrice:money(row[indexes[2]]) };
  });
  if (!catalog.length || new Set(catalog.map(p=>p.name)).size!==catalog.length) throw new Error('부품명이 비어 있거나 중복되었습니다. 가격표에서 부품을 구분해 주세요.');
  return catalog;
}
