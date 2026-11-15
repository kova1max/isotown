# Terminal part of the README demo, recorded with VHS (https://github.com/charmbracelet/vhs):
#   vhs demo/demo.tape
# The browser part (zooming the viewer, day to night) is a screen capture, downscaled
# with nearest-neighbour so the pixels stay hard.

Output demo/terminal.gif
Set FontSize 28
Set Width 1600
Set Height 1000
Set Padding 40
Set TypingSpeed 60ms

Hide
Type "cd $(mktemp -d) && clear"
Enter
Show

Type `npx isotown "Amsterdam"`
Sleep 400ms
Enter
Wait+Screen@10m /open .*index.html/
Sleep 3s
