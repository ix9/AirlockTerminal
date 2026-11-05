// Terminal colours for each theme. The rest of the UI is themed in style.css.
// ANSI palettes follow VS Code's. Programs often pick colours assuming a dark background, so
// minimumContrastRatio lets xterm.js adjust any that would be hard to read.

const TERMINAL_THEMES = {
  dark: {
    minimumContrastRatio: 1,
    colors: {
      background: '#181818', foreground: '#cccccc', cursor: '#cccccc', selectionBackground: '#264f78',
      black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510',
      blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
      brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543',
      brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#e5e5e5',
    },
  },
  light: {
    minimumContrastRatio: 4.5,
    colors: {
      background: '#ffffff', foreground: '#3b3b3b', cursor: '#3b3b3b', selectionBackground: '#add6ff',
      black: '#000000', red: '#cd3131', green: '#00bc00', yellow: '#949800',
      blue: '#0451a5', magenta: '#bc05bc', cyan: '#0598bc', white: '#555555',
      brightBlack: '#666666', brightRed: '#cd3131', brightGreen: '#14ce14', brightYellow: '#b5ba00',
      brightBlue: '#0451a5', brightMagenta: '#bc05bc', brightCyan: '#0598bc', brightWhite: '#a5a5a5',
    },
  },
  contrast: {
    minimumContrastRatio: 7,
    colors: {
      background: '#000000', foreground: '#ffffff', cursor: '#ffffff', selectionBackground: '#264f78',
      black: '#000000', red: '#cd0000', green: '#00cd00', yellow: '#cdcd00',
      blue: '#0000ee', magenta: '#cd00cd', cyan: '#00cdcd', white: '#e5e5e5',
      brightBlack: '#7f7f7f', brightRed: '#ff0000', brightGreen: '#00ff00', brightYellow: '#ffff00',
      brightBlue: '#5c5cff', brightMagenta: '#ff00ff', brightCyan: '#00ffff', brightWhite: '#ffffff',
    },
  },
};
