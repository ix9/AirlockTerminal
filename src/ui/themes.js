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
  // From VS Code's built-in theme.
  monokai: {
    minimumContrastRatio: 1,
    colors: {
      background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f0', selectionBackground: '#878b9180',
      black: '#333333', red: '#c4265e', green: '#86b42b', yellow: '#b3b42b',
      blue: '#6a7ec8', magenta: '#8c6bc8', cyan: '#56adbc', white: '#e3e3dd',
      brightBlack: '#666666', brightRed: '#f92672', brightGreen: '#a6e22e', brightYellow: '#e2e22e',
      brightBlue: '#819aff', brightMagenta: '#ae81ff', brightCyan: '#66d9ef', brightWhite: '#f8f8f2',
    },
  },
  // From the Oceanic Next palette. Black is lifted one step so it shows on the background.
  oceanic: {
    minimumContrastRatio: 1,
    colors: {
      background: '#1b2b34', foreground: '#c0c5ce', cursor: '#c0c5ce', selectionBackground: '#4f5b66',
      black: '#343d46', red: '#ec5f67', green: '#99c794', yellow: '#fac863',
      blue: '#6699cc', magenta: '#c594c5', cyan: '#5fb3b3', white: '#c0c5ce',
      brightBlack: '#65737e', brightRed: '#ec5f67', brightGreen: '#99c794', brightYellow: '#fac863',
      brightBlue: '#6699cc', brightMagenta: '#c594c5', brightCyan: '#5fb3b3', brightWhite: '#d8dee9',
    },
  },
};
