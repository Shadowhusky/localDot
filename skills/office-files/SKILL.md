---
name: office-files
description: Make, convert and fill LibreOffice documents and spreadsheets from the shell, faster and more reliably than through the GUI.
---
# Office files from the shell

LibreOffice runs headless from the terminal. Prefer this to clicking through menus when you create
or convert a file; open the result in the GUI afterwards if the user should see it.

## Spreadsheets
- Write the data as CSV first (`files` write, or Python's `csv` module), then convert:
  `soffice --headless --convert-to ods --outdir ~/Documents ~/Documents/data.csv`
- For formulas or several sheets, write the sheet with Python and odfpy if it is installed
  (`python3 -c "import odf"`), else build it from CSV per sheet.
- To read a spreadsheet: `soffice --headless --convert-to csv --outdir /tmp file.ods`, then read
  the CSV.

## Documents
- Write Markdown, then `pandoc notes.md -o ~/Documents/notes.odt` (or `.docx`).
- To read a document's text: `pandoc file.docx -t plain`.

## Notes
- Avoid overwriting a document that is still open in the GUI. For a separate headless conversion, use a fresh temporary LibreOffice profile with `-env:UserInstallation=file:///tmp/<unique-profile>` and remove only that profile afterwards.
- Conversions land in `--outdir` under the same name with the new extension.
- Check the converted document opens and contains the expected text, formulas or sheets before giving the user the final file with `done`.
