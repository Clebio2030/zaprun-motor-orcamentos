// motor/encoding.js
// Decodificação WIN1252 das colunas de texto vindas do Firebird.
//
// As colunas TEXT das views vêm de campos Firebird CHARACTER SET NONE contendo
// bytes WIN1252 (0xE3=ã, 0xE9=é). O node-firebird decodifica campos NONE como
// UTF-8, então cada byte de acento vira U+FFFD ("♦") — perda irreversível na
// leitura. Solução: as próprias views entregam essas colunas via
// CAST(col AS ... CHARACTER SET OCTETS), que o driver devolve como Buffer com os
// bytes crus; aqui decodificamos WIN1252 corretamente. Ver sql/views_zaprun.sql.
//
// WIN1252 == latin1 exceto na faixa 0x80–0x9F (aspas curvas, €, travessão, etc.),
// mapeada abaixo. Fora dela, o byte é o próprio code point (latin1).
//
// Isto foi caro de acertar no motor anterior. Se um acento aparecer errado no
// painel, o problema está na VIEW (esqueceu o CAST ... OCTETS), não aqui.

const WIN1252_C1 = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…',
  0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8A: 'Š',
  0x8B: '‹', 0x8C: 'Œ', 0x8E: 'Ž', 0x91: '‘', 0x92: '’',
  0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—',
  0x98: '˜', 0x99: '™', 0x9A: 'š', 0x9B: '›', 0x9C: 'œ',
  0x9E: 'ž', 0x9F: 'Ÿ'
};

function decodeWin1252(buf) {
  let out = '';
  for (const b of buf) {
    out += (b >= 0x80 && b <= 0x9F && WIN1252_C1[b]) ? WIN1252_C1[b] : String.fromCharCode(b);
  }
  return out;
}

/** Buffer (OCTETS) → string WIN1252 decodificada. Qualquer outra coisa → String(). */
function fixEncoding(v) {
  if (Buffer.isBuffer(v)) return decodeWin1252(v);
  return String(v);
}

/**
 * Lê um campo de texto de uma linha do Firebird, tolerando maiúscula/minúscula
 * no nome da coluna (o driver roda com lowercase_keys, mas as views usam
 * MAIÚSCULA e nem toda instalação se comporta igual).
 *
 * Retorna sempre string trimada; ausente/NULL → ''.
 */
function readText(row, campo) {
  const v = row[campo] ?? row[String(campo).toLowerCase()] ?? '';
  if (v === null || v === undefined) return '';
  return fixEncoding(v).trim();
}

/** Como readText, mas devolve null (não '') quando não há valor. Facilita JSON. */
function readTextOrNull(row, campo) {
  const s = readText(row, campo);
  return s === '' ? null : s;
}

module.exports = { decodeWin1252, fixEncoding, readText, readTextOrNull };
