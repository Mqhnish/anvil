#!/usr/bin/env python3
"""Export the eight-section write-up as a readable three-page PDF."""
from pathlib import Path
from html import escape
import re
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.pagesizes import A4
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'output/pdf/anvil-writeup.pdf'
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
INK, MUTED, ACCENT = colors.HexColor('#172534'), colors.HexColor('#536171'), colors.HexColor('#1769aa')
body = ParagraphStyle('Body', fontName='Helvetica', fontSize=9.2, leading=13, textColor=INK, spaceAfter=8)
heading = ParagraphStyle('Heading', parent=body, fontName='Helvetica-Bold', fontSize=12, leading=16, spaceBefore=10, spaceAfter=8)
small = ParagraphStyle('Small', parent=body, fontSize=8, leading=11, textColor=MUTED)
cell = ParagraphStyle('Cell', parent=body, fontSize=7.6, leading=10, spaceAfter=0)
title = ParagraphStyle('Title', parent=body, fontName='Helvetica-Bold', fontSize=24, leading=28, spaceAfter=10)

def footer(canvas, doc):
    canvas.setStrokeColor(colors.HexColor('#dce3e9'))
    canvas.line(42, 40, A4[0]-42, 40)
    canvas.setFont('Helvetica', 8)
    canvas.setFillColor(MUTED)
    canvas.drawString(42, 26, 'ANVIL / TOKENISERS  -  TRUEFOUNDRY FORGE-A-THON ROUND 1')
    canvas.drawRightString(A4[0]-42, 26, str(doc.page))

def paragraph(text, style=body):
    # Escape first, then turn bare URLs into clickable links.
    marked = re.sub(r'(https?://[^\s<]+[^\s<.,;:)])', r'<link href="\1" color="#1769aa">\1</link>', escape(text))
    return Paragraph(marked, style)

text = (ROOT / 'WRITEUP.md').read_text()
sections = re.split(r'^## ', text, flags=re.M)[1:]
story = [paragraph('Anvil', title), paragraph('Coding with context and review', heading), paragraph('TrueFoundry Forge-a-thon | Round 1 submission', small), Spacer(1, 6)]
for section in sections:
    name, content = section.split('\n', 1)
    number = int(name.split('.')[0])
    if number in (4, 6):
        story.append(PageBreak())
    story.append(paragraph(name, heading))
    blocks = content.strip().split('\n\n')
    for block in blocks:
        if block.startswith('|'):
            rows = [[paragraph(c.strip(), cell) for c in line.strip('|').split('|')] for line in block.splitlines() if not re.match(r'^\|[\s:|\-]+\|$', line)]
            table = Table(rows, colWidths=[82, 206, 206], repeatRows=1, hAlign='LEFT')
            table.setStyle(TableStyle([('VALIGN',(0,0),(-1,-1),'TOP'),('BACKGROUND',(0,0),(-1,0),colors.HexColor('#eaf1f7')),('LINEBELOW',(0,0),(-1,0),0.7,ACCENT),('LINEBELOW',(0,1),(-1,-1),0.3,colors.HexColor('#dce3e9')),('LEFTPADDING',(0,0),(-1,-1),6),('RIGHTPADDING',(0,0),(-1,-1),6),('TOPPADDING',(0,0),(-1,-1),6),('BOTTOMPADDING',(0,0),(-1,-1),6)]))
            story.extend([table, Spacer(1,8)])
        else:
            story.append(paragraph(block.replace('\n',' ')))
doc = SimpleDocTemplate(str(OUTPUT), pagesize=A4, leftMargin=42, rightMargin=42, topMargin=38, bottomMargin=52, title='Anvil - Round 1 write-up', author='Tokenisers')
doc.build(story, onFirstPage=footer, onLaterPages=footer)
if doc.page > 3:
    raise SystemExit(f'Write-up is {doc.page} pages; shorten it to the required maximum of 3 before submitting.')
print(OUTPUT)
