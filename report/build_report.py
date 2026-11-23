"""Builds report/Shadow_Sculptor_Report.pdf (12 pt body, US Letter)."""
from pathlib import Path
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib import colors
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Image,
                                ListFlowable, ListItem, Table, TableStyle, KeepTogether)

HERE = Path(__file__).parent
URL = "https://shadow-sculptor.shadow-sculptor.workers.dev"

body = ParagraphStyle("body", fontName="Times-Roman", fontSize=12, leading=14.6, spaceAfter=4)
h1 = ParagraphStyle("h1", fontName="Times-Bold", fontSize=17, leading=20, spaceAfter=2)
h2 = ParagraphStyle("h2", fontName="Times-Bold", fontSize=13.5, leading=16, spaceBefore=8, spaceAfter=3)
meta = ParagraphStyle("meta", parent=body, spaceAfter=1)
cap = ParagraphStyle("cap", parent=body, fontName="Times-Italic", fontSize=12, leading=14)


def P(t, s=body):
    return Paragraph(t, s)


def bullets(items):
    return ListFlowable([ListItem(P(i), leftIndent=14) for i in items],
                        bulletType="bullet", bulletFontSize=9, leftIndent=14, spaceAfter=4)


story = [
    P("Shadow Sculptor: Build a Game, Challenge an AI Agent", h1),
    P("<b>Name:</b> Junyao Han", meta),
    P(f'<b>Playable link:</b> <link href="{URL}" color="blue">{URL}</link>', meta),
    Spacer(1, 4),

    P("1. Game Description", h2),
    P("<b>Concept.</b> A lamp shines on a small sculpture made of 4 to 8 cubes, casting its shadow on a "
      "wall. The wall also shows a dark <i>target</i> shadow. The player rotates the sculpture until "
      "its shadow covers the target. Covered areas turn gold and spill turns red, so progress is easy to see."),
    P("<b>Objective.</b> Score as many points as possible in 90 seconds by matching one shadow after "
      "another. Each sculpture can be submitted only once, and every new sculpture has more cubes than the last."),
    P("<b>Controls.</b> Drag with the mouse, or use W A S D or the arrow keys, to tilt the sculpture. "
      "Q and E (or the scroll wheel) spin it within the wall plane. Hold Shift for fine control. "
      "Space locks in an answer and X skips the sculpture."),
    P("<b>Scoring / win condition.</b> The server measures the match as intersection-over-union (IoU) "
      "between the player's shadow and the target. A match below 80% scores 0. Matches from 80% to 100% "
      "map to 0 to 1000 points, plus a speed bonus of up to 50% for answering quickly. The final score "
      "goes on a shared online leaderboard, and the highest score wins."),

    P("<b>What makes it hard for an AI agent.</b> I designed against two kinds of agents: "
      "<i>screenshot agents</i> (for example Browser Use), which see the page and click, and "
      "<i>code agents</i> (for example Claude Code), which can read the source and call the API directly.", body),
    bullets([
        "<b>3D mental rotation under time pressure.</b> Humans rotate shapes intuitively. A vision model "
        "has to infer a 3D pose from a 2D screenshot, and a screenshot-think-act loop that takes several "
        "seconds wastes the clock. Submitting faster than 2 seconds per round scores 0.",
        "<b>No numeric feedback while playing.</b> The game shows only colors, never a live "
        "“% match”, so an agent cannot climb toward the answer by reading a number off the page.",
        "<b>The answer never reaches the browser.</b> The target rotation is stored only in the "
        "server database (Cloudflare D1). The browser receives just the cube layout and a blurred "
        "128×128 bitmap of the target shadow, so reading the JavaScript does not reveal the answer.",
        "<b>The server keeps score.</b> The score shown on screen is drawn on a canvas for display only. "
        "Editing variables in the browser console does not change the score the server records.",
        "<b>One try per round.</b> An atomic database update (compare-and-set) rejects a second "
        "submission for the same round, so the server cannot be used as a scoring oracle.",
    ]),

    P("2. Development Process &amp; AI Tricks", h2),
    P("<b>Tools.</b> Claude Code (Claude Opus 5.5) in the Claude desktop app wrote all of the code: Three.js "
      "rendering, a Cloudflare Worker API, and a Cloudflare D1 database, deployed on the free tier. The "
      "app's built-in browser let the AI play-test its own build."),
    P("<b>Trick 1: Have the AI think like an attacker before writing code.</b> I first asked Claude how "
      "each kind of agent would beat a game: screenshot agents are slow and weak at 3D perception, while "
      "code agents read the source or edit the score. Hence a timed 3D puzzle with server-side answers and scoring."),
    P("<b>Trick 2: Tune the rules with data instead of guesses.</b> My first threshold was a 60% match. "
      "I had the AI simulate random rotations, which gave a median match of 57% and a 99th percentile of "
      "86%, so random guessing would have scored easily. I raised the threshold to 80% and made the scoring "
      "curve steeper, so luck now earns close to nothing."),
    P("<b>Trick 3: Check every API response for leaked information.</b> The first plan sent the target "
      "shadow as one outline per cube. The AI noticed that one cube's outline reveals the exact rotation, "
      "so I switched to a soft, low-resolution bitmap of the whole shadow."),
]

cell = ParagraphStyle("cell", parent=body, spaceAfter=0, leading=14)
cellb = ParagraphStyle("cellb", parent=cell, fontName="Times-Bold")
rows = [
    ["Agent", "How it played", "Rounds", "Match per round", "Final score"],
    ["Screenshot agent (Claude, built-in browser)", "Screenshots, drag, scroll, keys", "5",
     "49% to 81%", "8"],
    ["Code agent v1 (Claude Code), before hardening", "Script that calls the API directly", "74",
     "88% to 100% (median 99.7%)", "105,345"],
    ["Code agent v1, after hardening", "Same script", "74", "Rejected: no input log", "0"],
    ["Code agent v2, after hardening", "Script that also forges a drag log", "40",
     "98% to 100%", "55,886"],
]
results_table = Table([[Paragraph(c, cellb if i == 0 else cell) for c in r] for i, r in enumerate(rows)],
                      colWidths=[1.65 * inch, 1.6 * inch, 0.85 * inch, 1.35 * inch, 0.95 * inch])
results_table.setStyle(TableStyle([
    ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eeeeee")),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("TOPPADDING", (0, 0), (-1, -1), 2), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
]))

story += [
    P("<b>Tricks 4 and 5: Red-team the backend and let the AI play its own build.</b> Scripted bad requests "
      "(instant answers, repeat submissions, malformed data, a <font face='Courier'>&lt;script&gt;</font> name) "
      "were all rejected. AI play-testing in the browser caught pixelated target edges, which are now blurred."),

    P("3. Challenging My Own Game with AI Agents", h2),
    P("I ran full 90-second games on the live site with each agent, then hardened the game and ran them again:"),
    results_table,
    Spacer(1, 6),
    P("<b>Screenshot agent: the design worked.</b> Claude played using only screenshots, drags, and keys. "
      "Each look-think-act cycle took about 5 seconds, and it often rotated the wrong way and had to undo. "
      "Only one of its four answers cleared the 80% bar (matches of 61%, 49%, 63%, and 81%)."),
    P("<b>Code agent: an unexpected winning strategy.</b> Claude Code skipped the interface. A 50-line "
      "script read each round's cube layout and target bitmap from the API, searched offline for the best "
      "rotation (random restarts plus hill climbing, about 1 second), and submitted it. Every anti-cheat "
      "rule held, yet it scored <b>105,345</b>: the information a human needs to see the puzzle is also "
      "everything an algorithm needs to solve it."),
    P("<b>Revision: hardening, then re-testing.</b> The browser no longer submits a rotation at all. The "
      "server picks each round's starting pose and replays the player's logged drag and key inputs to get "
      "the final pose. It rejects logs that are too short or turn faster than a human hand could, judges "
      "the answer at twice the resolution it shows, and requires at least 2 seconds per round. The original "
      "script dropped to <b>0</b>. Then Claude wrote a v2 that forges a smooth, human-looking drag log, "
      "which still scored <b>55,886</b>. <b>Lesson:</b> every check raised the cost of attacking, and the "
      "simple exploit no longer works. But any puzzle a person can solve from what is on screen, a "
      "determined code agent can solve too. The realistic goal is to make attacks take real effort, not "
      "to make them impossible."),
]

doc = SimpleDocTemplate(str(HERE / "Shadow_Sculptor_Report.pdf"), pagesize=letter,
                        leftMargin=0.9 * inch, rightMargin=0.9 * inch,
                        topMargin=0.75 * inch, bottomMargin=0.75 * inch,
                        title="Shadow Sculptor Report", author="Junyao Han")
doc.build(story)
print("ok")
