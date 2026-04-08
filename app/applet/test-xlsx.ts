import * as xlsx from 'xlsx';

const wb = xlsx.utils.book_new();
const ws = xlsx.utils.aoa_to_sheet([["A", "B"], ["1", "2"]]);
ws["!ref"] = "A1:B10000"; // simulate large empty range
xlsx.utils.book_append_sheet(wb, ws, "Sheet1");

console.log("Default CSV length:", xlsx.utils.sheet_to_csv(ws).length);
console.log("No blank rows CSV length:", xlsx.utils.sheet_to_csv(ws, { blankrows: false }).length);
