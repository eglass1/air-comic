import React, { useEffect, useState } from 'react';
import { Box, Typography } from '@mui/material';
import ReplyIcon from '@mui/icons-material/Reply';
import { useChat } from '../context/ChatContext';
import { AvatarManager } from '../comic/avatarManager';
import { ComicLayoutEngine, COMIC_FONT_FAMILY } from '../comic/comicLayout';
import { ComicBalloon, EM_NEUTRAL } from '../comic/types';

export const IncomingQuickMessageOverlay: React.FC = () => {
  const {
    incomingQuickMessage,
    dismissIncomingQuickMessage,
    replyToIncomingQuickMessage,
  } = useChat();

  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);

  // Handle Escape key to dismiss
  useEffect(() => {
    if (!incomingQuickMessage) {
      setImageDataUrl(null);
      return;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        dismissIncomingQuickMessage();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [incomingQuickMessage, dismissIncomingQuickMessage]);

  // Render character & comic balloon to an offscreen canvas and capture as image
  useEffect(() => {
    if (!incomingQuickMessage) {
      setImageDataUrl(null);
      return;
    }

    let isMounted = true;
    const rawAvatarName = incomingQuickMessage.senderAvatarName || 'Armando';

    AvatarManager.getInstance()
      .loadAvatar(rawAvatarName)
      .then((avatarData) => {
        if (!isMounted) return;

        // Fall back to armando if avatarData failed to load
        const finalAvatarData =
          avatarData || AvatarManager.getInstance().getCachedAvatar('armando');

        if (!finalAvatarData) {
          console.warn('Could not load avatar for quick message overlay');
          return;
        }

        try {
          const emotion =
            typeof incomingQuickMessage.emotion === 'number'
              ? incomingQuickMessage.emotion
              : EM_NEUTRAL;
          const intensity =
            typeof incomingQuickMessage.intensity === 'number'
              ? incomingQuickMessage.intensity
              : 0.0;

          // Render character at native resolution
          const rendered = AvatarManager.getInstance().renderCharacter(
            finalAvatarData,
            emotion,
            intensity,
            false
          );

          // Avatar scaled to ~66% of previous 50% height (one-third smaller, ~0.333 of native size)
          const scale = 0.5 * (2 / 3);
          const charW = Math.round(rendered.canvas.width * scale);
          const charH = Math.round(rendered.canvas.height * scale);
          const scaledHeadX = Math.round(rendered.headX * scale);
          const scaledHeadY = Math.round(rendered.headY * scale);

          // Create offscreen canvas
          const offscreen = document.createElement('canvas');
          const ctx = offscreen.getContext('2d');
          if (!ctx) return;

          // Calculate balloon text dimensions
          const safeText = (incomingQuickMessage.text || '').trim() || '...';
          ctx.font = `bold 12px ${COMIC_FONT_FAMILY}`;
          const lines = ComicLayoutEngine.getWrappedLines(ctx, safeText, 210);
          const lineHeight = 16;
          let maxLineW = 60;
          for (const line of lines) {
            const w = ctx.measureText(line.trim()).width;
            if (w > maxLineW) maxLineW = w;
          }

          const bW = Math.max(120, Math.min(260, Math.round(maxLineW + 36)));
          const bH = Math.max(42, lines.length * lineHeight + 24);

          // Size offscreen canvas to hold both balloon above and character below
          const canvasW = Math.max(bW + 28, charW + 40);
          const bX = Math.round((canvasW - bW) / 2);
          const bY = 8; // near top of canvas

          const charX = Math.round((canvasW - charW) / 2);
          const charY = bY + bH + 18; // placed cleanly below balloon to avoid covering head
          const canvasH = charY + charH + 10;

          offscreen.width = canvasW;
          offscreen.height = canvasH;

          // Clear offscreen canvas
          ctx.clearRect(0, 0, canvasW, canvasH);

          // 1. Draw character at 50% scale
          ctx.drawImage(rendered.canvas, charX, charY, charW, charH);

          // Find topmost opaque pixel in rendered character to find the top of the head/hair
          let headTopY = 0;
          try {
            const rCtx = rendered.canvas.getContext('2d');
            if (rCtx) {
              const scanH = Math.min(80, rendered.canvas.height);
              const scanW = rendered.canvas.width;
              const imgData = rCtx.getImageData(0, 0, scanW, scanH).data;
              outer: for (let y = 0; y < scanH; y++) {
                for (let x = 0; x < scanW; x++) {
                  if (imgData[(y * scanW + x) * 4 + 3] > 40) {
                    headTopY = y;
                    break outer;
                  }
                }
              }
            }
          } catch {
            headTopY = 0;
          }

          const headTopCanvasY = charY + Math.round(headTopY * scale);

          // Terminate stem slightly touching/penetrating the top of the head without covering the face
          const tailX = charX + scaledHeadX;
          const tailY = headTopCanvasY + 2;

          const balloon: ComicBalloon = {
            id: `qm-${incomingQuickMessage.id}`,
            speakerParticipantId: incomingQuickMessage.senderParticipantId,
            speakerName: incomingQuickMessage.senderScreenName,
            text: safeText,
            mode: 'say',
            x: bX,
            y: bY,
            width: bW,
            height: bH,
            tailX,
            tailY,
          };

          ComicLayoutEngine.drawBalloon(ctx, balloon);

          const url = offscreen.toDataURL('image/png');
          if (isMounted) {
            setImageDataUrl(url);
          }
        } catch (err) {
          console.error('Error rendering incoming quick message overlay:', err);
        }
      })
      .catch((err) => {
        console.error('Error loading avatar in incoming quick message:', err);
      });

    return () => {
      isMounted = false;
    };
  }, [incomingQuickMessage]);

  if (!incomingQuickMessage) return null;

  return (
    <Box
      onClick={dismissIncomingQuickMessage}
      sx={{
        position: 'fixed',
        inset: 0,
        zIndex: 1350,
        bgcolor: 'rgba(0, 0, 0, 0.12)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'flex-end',
        pb: 3,
        cursor: 'default',
        userSelect: 'none',
        animation: 'fadeIn 0.2s ease-out',
        '@keyframes fadeIn': {
          from: { opacity: 0, transform: 'scale(0.96)' },
          to: { opacity: 1, transform: 'scale(1)' },
        },
      }}
    >
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 1,
        }}
      >
        {/* Rendered 50% scale avatar & comic word balloon */}
        {imageDataUrl && (
          <Box
            component="img"
            src={imageDataUrl}
            alt="Quick Message"
            sx={{
              display: 'block',
              maxWidth: '90vw',
              maxHeight: '65vh',
              objectFit: 'contain',
              pointerEvents: 'none',
              filter: 'drop-shadow(0 6px 20px rgba(0,0,0,0.4))',
            }}
          />
        )}

        {/* Yellow capsule box styled like comic panel title banners */}
        <Box
          onClick={(e) => {
            e.stopPropagation();
            replyToIncomingQuickMessage();
          }}
          sx={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 0.8,
            px: 2.2,
            py: 0.7,
            bgcolor: '#ffde59',
            color: '#000000',
            border: '2.5px solid #000000',
            borderRadius: '20px',
            boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
            cursor: 'pointer',
            fontFamily: COMIC_FONT_FAMILY,
            fontWeight: 900,
            fontSize: '0.95rem',
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            transition: 'transform 0.15s ease, box-shadow 0.15s ease, background-color 0.15s ease',
            '&:hover': {
              transform: 'scale(1.06)',
              boxShadow: '0 6px 18px rgba(0,0,0,0.45)',
              bgcolor: '#ffe57f',
            },
            '&:active': {
              transform: 'scale(0.97)',
            },
          }}
          title="Click to Reply"
        >
          <ReplyIcon sx={{ fontSize: 18, color: '#000000' }} />
          <Typography
            component="span"
            sx={{
              fontFamily: COMIC_FONT_FAMILY,
              fontWeight: 900,
              fontSize: '0.95rem',
              color: '#000000',
              lineHeight: 1,
            }}
          >
            {incomingQuickMessage.senderScreenName}
          </Typography>
        </Box>
      </Box>
    </Box>
  );
};
