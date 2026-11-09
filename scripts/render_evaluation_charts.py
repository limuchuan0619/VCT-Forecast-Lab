"""Render dated aggregate evidence only. No collection, fitting or Test rerun.

Optional chart dependency: Pillow. Outputs PNG for GitHub and editable SVG.
Run from any directory: python scripts/render_evaluation_charts.py
"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
BG, PANEL, FG, MUTED, GRID = '#0d1117', '#161b22', '#e6edf3', '#9da7b1', '#30363d'
COLORS = {'champion': '#d6b16c', 'c1': '#65a9f3', 'elo': '#a9a1c8'}


def wilson(k, n):
    z = 1.959963984540054
    p = k / n
    center = (p + z*z/(2*n)) / (1 + z*z/n)
    half = z * math.sqrt(p*(1-p)/n + z*z/(4*n*n)) / (1 + z*z/n)
    return center-half, center+half


class Figure:
    """One primitive scene, rendered identically to PNG and SVG."""
    def __init__(self, width, height, font):
        self.width, self.height, self.font = width, height, font
        self.image = Image.new('RGB', (width*2, height*2), BG)
        self.draw = ImageDraw.Draw(self.image)
        self.svg = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
                    f'<rect width="{width}" height="{height}" fill="{BG}"/>']

    def rect(self, x, y, w, h, fill):
        self.draw.rectangle((x*2,y*2,(x+w)*2,(y+h)*2),fill=fill)
        self.svg.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{fill}"/>')

    def line(self, x1,y1,x2,y2,color=GRID,width=1):
        self.draw.line((x1*2,y1*2,x2*2,y2*2),fill=color,width=max(1,round(width*2)))
        self.svg.append(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{color}" stroke-width="{width}"/>')

    def text(self, x,y,value,size=22,color=FG,bold=False):
        font = ImageFont.truetype(str(self.font),round(size*2))
        self.draw.text((round(x*2),round(y*2)),str(value),fill=color,font=font,anchor='lt',stroke_width=0)
        self.svg.append(f'<text x="{x}" y="{y+size*.84}" font-family="Segoe UI,Arial,sans-serif" font-size="{size}" fill="{color}" font-weight="{600 if bold else 400}">{html.escape(str(value))}</text>')

    def save(self, path, title, description):
        self.image.save(path.with_suffix('.png'),optimize=True)
        self.svg.insert(1,f'<title>{html.escape(title)}</title><desc>{html.escape(description)}</desc>')
        path.with_suffix('.svg').write_text('\n'.join(self.svg+['</svg>'])+'\n',encoding='utf-8')


def header(fig, kicker, title, subtitle):
    fig.text(52,35,'VCT FORECAST LAB  /  EVALUATION',18,MUTED)
    fig.text(52,79,title,38,bold=True)
    fig.text(52,138,subtitle,21,MUTED)
    fig.text(52,177,kicker,18,COLORS['champion'])


def accuracy_axis(fig, x,y,width,height):
    for tick in range(0,101,20):
        at=x+width*tick/100
        fig.line(at,y,at,y+height,GRID)
        fig.text(at-10,y+height+12,f'{tick}%',16,MUTED)


def accuracy_bar(fig, x,y,width,accuracy,n,color,label):
    correct=round(accuracy*n)
    assert abs(correct/n-accuracy)<1e-6, 'Accuracy must match an integer winner count'
    fig.rect(x,y,width*accuracy,28,color)
    lo,hi=wilson(correct,n)
    fig.line(x+width*lo,y+14,x+width*hi,y+14,FG,2)
    for edge in (lo,hi): fig.line(x+width*edge,y+7,x+width*edge,y+21,FG,2)
    fig.text(x,y-28,label,20,color)
    fig.text(x+width+18,y+1,f'{accuracy:.1%}  |  {correct}/{n}',20,color)


def render(snapshot, historical, assets, font):
    date=snapshot['snapshot_at'][:10]
    digest=hashlib.sha256(json.dumps(snapshot,sort_keys=True).encode()).hexdigest()[:10]
    live=snapshot['prospective']
    primary=next(c for c in live['cohortEvaluation']['cohorts'] if c['cohort']=='primary_vct')
    historical_rows=[('Elo baseline','elo','elo'),('Champion replay proxy','champion_v1_replay_proxy','champion'),('Logistic C1','logistic_c1','c1')]

    fig=Figure(1600,830,font)
    header(fig,'HISTORICAL AND PROSPECTIVE RESULTS ARE SEPARATE','Winner prediction accuracy',f'Historical: one frozen Test evaluation. Prospective: real pre-match locks. Snapshot {date}.')
    for left,title,subtitle in [(40,'01  Frozen historical test','200 matches  |  650 train / 150 validation / 200 test'),(820,'02  Live primary VCT cohort','34 paired matches  |  original review gate: 100')]:
        fig.rect(left,230,740,424,PANEL)
        fig.text(left+28,254,title,28,bold=True)
        fig.text(left+28,300,subtitle,18,MUTED)
        accuracy_axis(fig,left+28,365,460,220)
    for i,(label,key,color) in enumerate(historical_rows):
        m=historical['test_metrics'][key]
        accuracy_bar(fig,68,391+i*77,460,m['accuracy'],m['n'],COLORS[color],label)
    for i,(label,key,color) in enumerate([('Champion V1.0.0','champion','champion'),('Frozen Logistic C1','c1','c1')]):
        accuracy_bar(fig,848,411+i*104,460,primary[key]['accuracy'],primary['matches'],COLORS[color],label)
    fig.text(52,691,'Whiskers: descriptive 95% Wilson intervals. Wide overlap is expected with small samples.',21,MUTED)
    fig.text(52,731,'Champion historical row is a partial replay proxy. No Elo prospective record is claimed.',20,MUTED)
    fig.text(52,774,f'Accuracy alone is not a promotion criterion.  |  Data {digest}',18,MUTED)
    fig.save(assets/'model-accuracy','Historical and real prospective accuracy','Both accuracy axes run from zero to 100 percent. Historical and prospective samples are not pooled.')

    order=['primary_vct','qualification:CN','secondary:EMEA','qualification:AMERICAS','invitational:EMEA','invitational:AMERICAS']
    labels={'primary_vct':'Primary VCT','qualification:CN':'CN qualification','secondary:EMEA':'EMEA secondary','qualification:AMERICAS':'Americas qualification','invitational:EMEA':'EMEA invitational','invitational:AMERICAS':'Americas invitational'}
    cohorts={c['cohort']:c for c in live['cohortEvaluation']['cohorts']}
    fig=Figure(1600,1230,font)
    header(fig,'ALL AVAILABLE COHORTS SHOWN  /  NO POOLED LEADERBOARD','Performance changes across competition levels',f'{live["cohortEvaluation"]["valid_resolved_matches"]} valid pairs across separate cohorts. Only primary VCT contributes to the 100-match gate.')
    fig.text(382,229,'Champion V1.0.0',20,COLORS['champion'])
    fig.text(683,229,'Frozen Logistic C1',20,COLORS['c1'])
    accuracy_axis(fig,382,286,840,748)
    for i,key in enumerate(order):
        c=cohorts[key]; y=299+i*120
        fig.text(52,y+3,labels[key],24,bold=True)
        fig.text(52,y+43,f'n = {c["matches"]}'+('  |  very small sample' if c['matches']<10 else ''),18,MUTED)
        for j,model in enumerate(('champion','c1')):
            # Cohort label and legend carry names; keep each paired row compact.
            accuracy_bar(fig,382,y+j*43,840,c[model]['accuracy'],c['matches'],COLORS[model],'')
        if i<5: fig.line(52,y+103,1510,y+103)
    fig.text(52,1090,'Whiskers: descriptive 95% Wilson intervals; shared teams and match dependence are not modeled.',20,MUTED)
    fig.text(52,1130,'n = 1-5 is insufficient to judge superiority. Every cohort remains preliminary; no promotion decision.',20,MUTED)
    fig.text(52,1174,f'Snapshot {date}  |  source: public overview aggregate  |  Data {digest}',18,MUTED)
    fig.save(assets/'cohort-accuracy','Prospective accuracy by competition cohort','Every cohort is shown, including unfavorable and tiny samples. No combined accuracy is presented.')

    fig=Figure(1600,790,font)
    header(fig,'SAME 34 REAL PROSPECTIVE PRIMARY-VCT MATCHES','Probability quality beyond the correct winner','Lower is better for every metric below. Calibration and winner accuracy answer different questions.')
    for left,key,title,limit in [(40,'brier','Brier score',.4),(560,'log_loss','Log loss',1),(1080,'ece_10_bin','Calibration error / ECE',.2)]:
        fig.rect(left,242,480,354,PANEL)
        fig.text(left+24,267,title,26,bold=True)
        x=left+24; width=290
        for i in range(5):
            t=limit*i/4
            at=x+width*t/limit
            fig.line(at,338,at,516)
            fig.text(at-8,533,f'{t:.2f}',15,MUTED)
        for i,(key_model,label,col) in enumerate([('champion','Champion','champion'),('c1','Logistic C1','c1')]):
            val=primary[key_model][key];y=369+i*94
            fig.text(x,y-28,label,19,COLORS[col])
            fig.rect(x,y,width*val/limit,30,COLORS[col])
            fig.text(x+width+13,y+3,f'{val:.4f}',20,COLORS[col])
    fig.text(52,640,'C1: lower Brier and Log Loss; higher calibration error on this early cohort.',23,FG)
    fig.text(52,686,'Point estimates only. This chart does not establish statistical superiority or promotion eligibility.',20,MUTED)
    fig.text(52,737,f'10 fixed ECE bins  |  Snapshot {date}  |  Data {digest}',18,MUTED)
    fig.save(assets/'probability-quality','Probability quality on 34 prospective paired matches','C1 has lower Brier and log loss but higher ECE. Each metric has its own clearly labeled zero-based axis.')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot',type=Path,default=ROOT/'docs/data/evaluation-snapshot-2026-11-09.json')
    parser.add_argument('--font',type=Path)
    args=parser.parse_args()
    candidates=[args.font,Path('C:/Windows/Fonts/segoeui.ttf'),Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')]
    font=next((p for p in candidates if p is not None and p.is_file()),None)
    if font is None: parser.error('Pass --font with an installed TrueType font.')
    snapshot=json.loads(args.snapshot.read_text(encoding='utf-8'))
    historical=json.loads((ROOT/'model/artifacts/logistic_c1_v1_4b_evaluation.json').read_text(encoding='utf-8'))
    assert snapshot['runtime']['metrics_trusted'] is True
    live=snapshot['prospective']
    assert not live['promotionEnabled'] and not live['historicalEvaluationIncluded']
    assert sum(c['matches'] for c in live['cohortEvaluation']['cohorts'])==live['cohortEvaluation']['valid_resolved_matches']
    assets=ROOT/'docs/assets';assets.mkdir(parents=True,exist_ok=True)
    render(snapshot,historical,assets,font)
    print('Rendered 3 PNG charts and 3 editable SVG charts from saved aggregate evidence.')


if __name__=='__main__': main()
