import React, { useState, useEffect } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  Box,
  Link,
  IconButton,
  Paper,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { AvatarManager } from '../comic/avatarManager';

const THIRD_PARTY_NOTICES_TEXT = `MIT License

Copyright (c) Microsoft Corporation.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED *AS IS*, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

interface AboutDialogProps {
  open: boolean;
  onClose: () => void;
}

export const AboutDialog: React.FC<AboutDialogProps> = ({ open, onClose }) => {
  const [showLicense, setShowLicense] = useState(false);
  const [armandoUrl, setArmandoUrl] = useState<string | null>(null);
  const [head1Url, setHead1Url] = useState<string | null>(null);
  const [head2Url, setHead2Url] = useState<string | null>(null);

  // Reset state and select random character heads each time dialog opens
  useEffect(() => {
    if (!open) {
      setShowLicense(false);
      return;
    }

    let isMounted = true;
    const avatarManager = AvatarManager.getInstance();

    // 1. Render Armando (full, standing)
    avatarManager.loadAvatar('armando').then((armando) => {
      if (!isMounted || !armando) return;
      const rendered = avatarManager.renderCharacter(armando, 0, 0, false);
      if (rendered?.canvas) {
        setArmandoUrl(rendered.canvas.toDataURL());
      }
    });

    // 2. Choose 2 random characters (excluding Earl and Armando)
    const candidates = AvatarManager.AVAILABLE_AVATARS.filter(
      (a) => a.id.toLowerCase() !== 'armando' && a.id.toLowerCase() !== 'earl'
    );

    if (candidates.length >= 2) {
      const idx1 = Math.floor(Math.random() * candidates.length);
      let idx2 = Math.floor(Math.random() * (candidates.length - 1));
      if (idx2 >= idx1) idx2++;

      const c1 = candidates[idx1];
      const c2 = candidates[idx2];

      Promise.all([
        avatarManager.loadAvatar(c1.id),
        avatarManager.loadAvatar(c2.id),
      ]).then(([av1, av2]) => {
        if (!isMounted) return;
        if (av1) {
          const head1 = avatarManager.renderAvatarIcon(av1);
          if (head1) setHead1Url(head1.toDataURL());
        }
        if (av2) {
          const head2 = avatarManager.renderAvatarIcon(av2);
          if (head2) setHead2Url(head2.toDataURL());
        }
      });
    }

    return () => {
      isMounted = false;
    };
  }, [open]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      PaperProps={{
        sx: {
          borderRadius: 3,
          p: 1,
        },
      }}
    >
      <DialogTitle
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontWeight: 700,
          pb: 1,
        }}
      >
        <span>About AirComic</span>
        <IconButton size="small" onClick={onClose} aria-label="close">
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>

      <DialogContent dividers sx={{ minHeight: 340, p: 3 }}>
        {showLicense ? (
          /* License View: Replaces main content with THIRD-PARTY-NOTICES.txt */
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Button
                variant="outlined"
                size="small"
                startIcon={<ArrowBackIcon />}
                onClick={() => setShowLicense(false)}
              >
                Back to About
              </Button>
              <Typography variant="subtitle2" sx={{ fontWeight: 700, color: 'text.secondary' }}>
                THIRD-PARTY-NOTICES.txt
              </Typography>
            </Box>

            <Paper
              variant="outlined"
              sx={{
                p: 2,
                bgcolor: 'action.hover',
                fontFamily: 'monospace',
                fontSize: '0.82rem',
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
                maxHeight: 380,
                overflowY: 'auto',
                borderRadius: 2,
              }}
            >
              {THIRD_PARTY_NOTICES_TEXT}
            </Paper>
          </Box>
        ) : (
          /* Main About View */
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
            {/* Logo circle & AirComic title row */}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: { xs: 'wrap', sm: 'nowrap' } }}>
              {/* Large Logo Circle (diameter 150px) with 3 mosaic panel sections */}
              <Box
                sx={{
                  width: 150,
                  height: 150,
                  minWidth: 150,
                  borderRadius: '50%',
                  bgcolor: '#0070f3',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 4px 18px rgba(0, 112, 243, 0.35)',
                  flexShrink: 0,
                  mx: { xs: 'auto', sm: 0 },
                }}
              >
                {/* Inner 3-panel mosaic grid */}
                <Box
                  sx={{
                    width: 104,
                    height: 104,
                    display: 'flex',
                    gap: '6px',
                  }}
                >
                  {/* Left taller section: Armando (full, standing) */}
                  <Box
                    sx={{
                      flex: '1 1 50%',
                      bgcolor: '#ffffff',
                      borderRadius: '12px 4px 4px 12px',
                      overflow: 'hidden',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      p: 0.4,
                      boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.06)',
                    }}
                  >
                    {armandoUrl && (
                      <Box
                        component="img"
                        src={armandoUrl}
                        alt="Armando"
                        sx={{
                          maxHeight: '100%',
                          maxWidth: '100%',
                          objectFit: 'contain',
                        }}
                      />
                    )}
                  </Box>

                  {/* Right column: 2 other character heads at random */}
                  <Box
                    sx={{
                      flex: '1 1 50%',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '6px',
                    }}
                  >
                    {/* Top-right panel: Random character head 1 */}
                    <Box
                      sx={{
                        flex: 1,
                        bgcolor: '#ffffff',
                        borderRadius: '4px 12px 4px 4px',
                        overflow: 'hidden',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        p: 0.3,
                        boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.06)',
                      }}
                    >
                      {head1Url && (
                        <Box
                          component="img"
                          src={head1Url}
                          alt="Character Head 1"
                          sx={{
                            maxHeight: '100%',
                            maxWidth: '100%',
                            objectFit: 'contain',
                          }}
                        />
                      )}
                    </Box>

                    {/* Bottom-right panel: Random character head 2 */}
                    <Box
                      sx={{
                        flex: 1,
                        bgcolor: '#ffffff',
                        borderRadius: '4px 4px 12px 4px',
                        overflow: 'hidden',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        p: 0.3,
                        boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.06)',
                      }}
                    >
                      {head2Url && (
                        <Box
                          component="img"
                          src={head2Url}
                          alt="Character Head 2"
                          sx={{
                            maxHeight: '100%',
                            maxWidth: '100%',
                            objectFit: 'contain',
                          }}
                        />
                      )}
                    </Box>
                  </Box>
                </Box>
              </Box>

              {/* Title & Version */}
              <Box>
                <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
                  <Typography
                    variant="h4"
                    component="span"
                    sx={{
                      display: 'inline-flex',
                      alignItems: 'baseline',
                      lineHeight: 1,
                      letterSpacing: '-0.3px',
                    }}
                  >
                    <span style={{ color: '#0070f3', fontWeight: 800 }}>Air</span>
                    <span
                      style={{
                        color: '#000000',
                        fontFamily: '"Comic Sans MS", "Comic Relief", "Comic Neue", "Chalkboard SE", sans-serif',
                        fontWeight: 700,
                      }}
                    >
                      Comic
                    </span>
                  </Typography>
                  <Typography
                    variant="h6"
                    component="span"
                    sx={{
                      color: 'text.secondary',
                      fontWeight: 600,
                      ml: 0.5,
                    }}
                  >
                    v1.0
                  </Typography>
                </Box>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.8 }}>
                  Decentralized, Peer-to-Peer Comic Chat
                </Typography>
              </Box>
            </Box>

            {/* Attribution & Reference Links */}
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, pt: 1 }}>
              <Typography variant="body1">
                AirComic is inspired by and based on Microsoft Comic Chat:
              </Typography>

              <Typography variant="body1">
                <Link
                  href="https://microsoft.github.io/comic-chat/"
                  target="_blank"
                  rel="noopener noreferrer"
                  sx={{
                    fontWeight: 600,
                    color: '#0070f3',
                    textDecoration: 'underline',
                    wordBreak: 'break-all',
                  }}
                >
                  https://microsoft.github.io/comic-chat/
                </Link>
              </Typography>

              <Box sx={{ pt: 1 }}>
                <Typography variant="body1" sx={{ mb: 1 }}>
                  This project includes code derived from Microsoft Comic Chat:
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ pl: 0.5 }}>
                  Copyright (c) Microsoft Corporation.
                  <br />
                  Licensed under the MIT License. See{' '}
                  <Link
                    component="button"
                    variant="body2"
                    onClick={() => setShowLicense(true)}
                    sx={{
                      verticalAlign: 'baseline',
                      textDecoration: 'underline',
                      fontWeight: 600,
                      cursor: 'pointer',
                      color: 'primary.main',
                    }}
                  >
                    THIRD-PARTY-NOTICES.txt
                  </Link>
                  .
                </Typography>
              </Box>

              <Box sx={{ pt: 0.5 }}>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  Modifications and original code:
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ pl: 0.5 }}>
                  Copyright (c) 2026 Eric Glass.
                  <br />
                  Licensed under the MIT License.
                </Typography>
              </Box>
            </Box>
          </Box>
        )}
      </DialogContent>

      <DialogActions sx={{ px: 3, py: 1.5 }}>
        {showLicense && (
          <Button onClick={() => setShowLicense(false)} sx={{ mr: 'auto' }}>
            Back
          </Button>
        )}
        <Button variant="contained" onClick={onClose} autoFocus>
          OK
        </Button>
      </DialogActions>
    </Dialog>
  );
};
