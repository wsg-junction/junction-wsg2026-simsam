$ErrorActionPreference = 'Stop'
$root = 'C:\Users\mailm\Desktop\Workspaces\junction-wsg2026-simsam'
$assets = Join-Path $root '.pitch-build'
$out = Join-Path $root 'output'
$previews = Join-Path $assets 'previews'
New-Item -ItemType Directory -Force -Path $out,$previews | Out-Null
$final = Join-Path $out 'Atlas-Pitch.pptx'
if (Test-Path -LiteralPath $final) { throw 'Output already exists' }
function RGB([string]$hex) {
  return [Convert]::ToInt32($hex.Substring(0,2),16) + 256*[Convert]::ToInt32($hex.Substring(2,2),16) + 65536*[Convert]::ToInt32($hex.Substring(4,2),16)
}
$navy = RGB '142337'; $amber = RGB 'B5780B'; $muted = RGB '586778'; $lightAmber = RGB 'E8AD32'
Add-Type -AssemblyName System.Drawing
$app = New-Object -ComObject PowerPoint.Application
$deck = $null
try {
  $deck = $app.Presentations.Add(0)
  $deck.PageSetup.SlideWidth = 960
  $deck.PageSetup.SlideHeight = 540
  function Text($slide,[string]$text,[double]$x,[double]$y,[double]$w,[double]$h,[double]$size,$color,[bool]$bold=$false) {
    $s = $slide.Shapes.AddTextbox(1,$x,$y,$w,$h)
    $s.Name = 'Text ' + $slide.Shapes.Count
    $s.TextFrame.MarginLeft = 0; $s.TextFrame.MarginRight = 0
    $s.TextFrame.MarginTop = 0; $s.TextFrame.MarginBottom = 0
    $s.TextFrame.WordWrap = -1; $s.TextFrame.AutoSize = 0
    $s.TextFrame.TextRange.Text = $text
    $s.TextFrame.TextRange.Font.Name = 'Arial'
    $s.TextFrame.TextRange.Font.Size = $size
    $s.TextFrame.TextRange.Font.Color.RGB = $color
    $s.TextFrame.TextRange.Font.Bold = $(if($bold){-1}else{0})
    $s.TextFrame.TextRange.ParagraphFormat.SpaceAfter = 0
    $s.TextFrame.TextRange.ParagraphFormat.SpaceBefore = 0
    $s.TextFrame2.AutoSize = 0
    $s.Width = $w; $s.Height = $h
    return $s
  }
  function Picture($slide,[string]$name,[double]$x,[double]$y,[double]$w,[double]$h) {
    $p = Join-Path $assets $name
    $img = [System.Drawing.Image]::FromFile($p)
    $ratio = [Math]::Min($w/$img.Width,$h/$img.Height)
    $pw=$img.Width*$ratio; $ph=$img.Height*$ratio; $img.Dispose()
    $s=$slide.Shapes.AddPicture($p,0,-1,($x+($w-$pw)/2),($y+($h-$ph)/2),$pw,$ph)
    $s.AlternativeText=$name.Replace('.png','').Replace('-',' ')
    return $s
  }
  function NewSlide([string]$notes,[int]$seconds) {
    $s=$deck.Slides.Add($deck.Slides.Count+1,12)
    $s.FollowMasterBackground=0; $s.Background.Fill.Solid(); $s.Background.Fill.ForeColor.RGB=RGB 'FFFFFF'
    $s.NotesPage.Shapes.Placeholders.Item(2).TextFrame.TextRange.Text = "Timing: $seconds seconds`r`n`r`n$notes"
    $s.SlideShowTransition.AdvanceOnClick=-1
    $s.SlideShowTransition.AdvanceOnTime=0
    $s.SlideShowTransition.AdvanceTime=$seconds
    return $s
  }

  $s=NewSlide 'You ask a simple question: what is Java? The assistant answers: Java is Taco Bell. Now serving potato tacos. A confident answer. A citation. Still wrong. What happens when the source behind an answer is unreliable? [Pause after the punchline.] This is an illustrative reenactment, not a verified historical quotation.' 15
  [void](Text $s 'What is Java?' 58 64 844 92 62 $navy $true)
  [void](Text $s 'Java is Taco Bell.' 62 235 830 66 43 $navy)
  [void](Text $s 'Now serving potato tacos.' 62 303 840 66 43 $amber $true)
  [void](Text $s 'A confident answer. A citation. Still wrong.' 62 425 820 35 22 $muted)
  [void](Text $s 'Illustrative reenactment' 62 492 700 22 12 $muted)

  $s=NewSlide 'Finding information is only the beginning. A citation gives us somewhere to investigate. We still need to ask what supports the claim, whether independent sources agree, and how the article changed. For students, researchers, and curious readers, those checks often mean opening more tabs and piecing together the evidence by hand. Atlas brings those steps together.' 20
  [void](Text $s 'A citation is a starting point' 58 55 845 64 39 $navy $true)
  [void](Text $s 'Three questions behind every answer' 60 135 820 34 23 $muted)
  [void](Text $s '01' 60 248 150 56 40 $lightAmber $true)
  [void](Text $s 'What supports it?' 60 318 245 80 25 $navy $true)
  [void](Text $s 'Open the source passage.' 60 414 255 58 18 $muted)
  [void](Text $s '02' 360 248 150 56 40 $lightAmber $true)
  [void](Text $s 'Do other sources agree?' 360 318 245 80 25 $navy $true)
  [void](Text $s 'Compare outside evidence.' 360 414 255 58 18 $muted)
  [void](Text $s '03' 660 248 150 56 40 $lightAmber $true)
  [void](Text $s 'What changed?' 660 318 245 80 25 $navy $true)
  [void](Text $s 'Inspect the article history.' 660 414 255 58 18 $muted)

  $s=NewSlide 'Meet Atlas, your research assistant. Start with a question and explore the Wikipedia articles behind the answer. Follow a connection on the topic map, dive into another article, or ask a follow-up. Your research stays together in one workspace, and you can save the whole exploration to return later. [Point to the connected topics.] Sources: README.md, sections on the Wikipedia corpus and saved explorations. Product screenshot from a saved local exploration.' 20
  [void](Picture $s 'logo.png' 58 51 58 58)
  [void](Text $s 'Meet Atlas' 58 151 350 75 48 $navy $true)
  [void](Text $s 'Your research assistant' 60 240 320 70 25 $muted)
  [void](Text $s 'Ask. Explore. Investigate.' 60 375 330 68 23 $amber $true)
  [void](Picture $s 'workspace-detail.png' 400 153 505 298)
  [void](Text $s 'Wikipedia sources, connected topics, and follow-up questions' 402 469 500 42 15 $muted)

  $s=NewSlide 'But finding information is only the beginning. Check claims against independent sources and see what is supported, what is contradicted, and where the evidence falls short. Atlas shows the original claim, what outside sources say, and excerpts you can inspect. Then look behind the page. The history view explains substantial revisions and shows what was added or removed. It helps you understand how the article became the version you are reading. These are tools for investigation, with the underlying evidence kept visible. Sources: README.md, Fact-check and History sections; apps/api/src/factcheck.ts; apps/api/src/timeline.ts. Screenshots show saved World War II results. History filters many reverted edits rather than providing automatic vandalism detection.' 40
  [void](Text $s 'Check the claim. Inspect the change.' 58 45 850 64 35 $navy $true)
  [void](Text $s 'Independent fact-checking' 60 131 410 35 23 $navy $true)
  [void](Text $s 'Readable article history' 510 131 410 35 23 $navy $true)
  [void](Picture $s 'factcheck-detail.png' 60 181 390 280)
  [void](Picture $s 'history-detail.png' 510 181 390 280)
  [void](Text $s 'Claims, verdicts, and source excerpts' 60 482 405 30 17 $muted)
  [void](Text $s 'Explanations, timelines, and word-level diffs' 510 482 405 30 17 $muted)

  $s=NewSlide 'Some questions deserve more than an answer. They deserve Deep Research. Powered by NVIDIA Nemotron, Atlas plans the investigation, connects relevant sources, and reads figures. It builds an in-depth report in parts, with key findings and numbered references. Explore events on an interactive timeline, inspect the figures, and follow citations back to the evidence. The report includes limitations alongside its conclusions. [Pause on the timeline.] Sources: README.md, Deep research and Figures sections; apps/api/src/report.ts; apps/api/src/media.ts. Screenshot from the saved report World War II: Causes, Course, and Consequences, 1939-1945.' 35
  [void](Text $s "Some questions deserve`r`nDeep Research" 58 57 510 118 39 $navy $true)
  [void](Text $s 'Powered by NVIDIA Nemotron' 60 201 485 34 22 $amber $true)
  [void](Text $s 'Interactive timelines' 60 289 450 36 25 $navy)
  [void](Text $s 'Figures and source citations' 60 348 470 36 25 $navy)
  [void](Text $s 'Findings and limitations' 60 407 470 36 25 $navy)
  [void](Picture $s 'timeline-detail.png' 595 55 310 430)

  $s=NewSlide 'MariaDB powers semantic search and preserves article history, connecting the evidence across topics and time. Deployed on Verda and built with Codex, Atlas combines NVIDIA Nemotron for deep research, ElevenLabs for hands-free exploration, context.dev for wider web research, and Gemini for independent fact-checking. Each service has a clear role, with MariaDB at the heart of retrieval and stored evidence. Sources: README.md; CLAUDE.md; deploy/compose.yml. Verda deployment and Codex development are confirmed by the project owner. Gemini evaluates Wikipedia claims against outside evidence, not Nemotron answers.' 25
  [void](Text $s 'Evidence across topics and time' 58 55 850 64 37 $navy $true)
  [void](Text $s 'MariaDB' 60 191 380 64 43 $navy $true)
  [void](Text $s "Semantic search`r`nVersioned article history`r`nStored research and sources" 62 280 380 145 24 $muted)
  [void](Text $s 'NVIDIA Nemotron' 505 183 380 32 23 $navy $true)
  [void](Text $s 'Deep research and figure reading' 505 217 390 28 18 $muted)
  [void](Text $s 'ElevenLabs' 505 270 380 32 23 $navy $true)
  [void](Text $s 'Hands-free exploration' 505 304 390 28 18 $muted)
  [void](Text $s 'context.dev' 505 357 380 32 23 $navy $true)
  [void](Text $s 'Wider web research' 505 391 390 28 18 $muted)
  [void](Text $s 'Gemini' 505 444 380 32 23 $navy $true)
  [void](Text $s 'Independent fact-checking' 505 478 390 28 18 $muted)
  [void](Text $s 'Deployed on Verda. Built with Codex.' 62 475 415 31 18 $amber $true)

  $s=NewSlide 'Start with a question. Leave with understanding. [Pause.] Atlas. Follow the evidence.' 10
  [void](Picture $s 'logo.png' 416 60 128 128)
  $t=Text $s 'Start with a question.' 70 238 820 65 45 $navy $true; $t.TextFrame.TextRange.ParagraphFormat.Alignment=2
  $t=Text $s 'Leave with understanding.' 50 308 860 65 45 $navy $true; $t.TextFrame.TextRange.ParagraphFormat.Alignment=2
  $t=Text $s 'Atlas. Follow the evidence.' 120 426 720 42 25 $amber $true; $t.TextFrame.TextRange.ParagraphFormat.Alignment=2

  $deck.SaveAs($final,24)
  for($i=1;$i -le $deck.Slides.Count;$i++) {
    $deck.Slides.Item($i).Export((Join-Path $previews ('slide-{0:D2}.png' -f $i)),'PNG',1600,900)
  }
  # Validate editable text against its box using PowerPoint's own layout engine.
  $warnings=@()
  foreach($slide in $deck.Slides) {
    foreach($shape in $slide.Shapes) {
      if($shape.HasTextFrame -eq -1 -and $shape.TextFrame.HasText -eq -1) {
        $r=$shape.TextFrame.TextRange
        if(($r.BoundHeight -gt ($shape.Height+2)) -or ($r.BoundWidth -gt ($shape.Width+2))) {$warnings += "Slide $($slide.SlideIndex): box=$($shape.Width)x$($shape.Height) text=$($r.BoundWidth)x$($r.BoundHeight) $($r.Text)"}
      }
      if(($shape.Left -lt -1) -or ($shape.Top -lt -1) -or (($shape.Left+$shape.Width) -gt 961) -or (($shape.Top+$shape.Height) -gt 541)) {$warnings += "Outside slide $($slide.SlideIndex): $($shape.Name)"}
    }
  }
  $warnings | Set-Content (Join-Path $assets 'layout-warnings.txt')
  Write-Output "Saved $final; slides=$($deck.Slides.Count); layout warnings=$($warnings.Count)"
} finally {
  if($null -ne $deck) { $deck.Close() }
  $app.Quit()
  [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($app)
}
