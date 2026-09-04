import React, { useEffect, useRef, useState } from 'react';
import { Box, Typography } from '@mui/material';
import ReplyIcon from '@mui/icons-material/Reply';
import { useChat } from '../context/ChatContext';
import { AvatarManager } from '../comic/avatarManager';
import { ComicLayoutEngine, COMIC_FONT_FAMILY } from '../comic/comicLayout';
import { ComicBalloon } from '../comic/types';

export const IncomingQuickMessageOverlay: React.FC = () => {
  const {
    incomingQuickMessage,
    dismissIncomingQuickMessage,
    replyToIncomingQuickMessage,
  } = useChat();

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>({ width: 280, height: 260 });

  // Handle Escape key to dismiss
  useEffect(() => {
    if (!incomingQuickMessage) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        dismissIncomingQuickMessage();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [incomingQuickMessage, dismissIncomingQuickMessage]);

  // Render character & comic balloon
  useEffect(() => {
    if (!incomingQuickMessage) return;

    let isMounted = true;
    const avatarName = incomingQuickMessage.senderAvatarName || 'Armando';

    AvatarManager.getInstance()
      .loadAvatar(avatarName)
      .then((avatarData) => {
        if (!isMounted || !avatarData) return;

        // Render character at original resolution
        const rendered = AvatarManager.getInstance().renderCharacter(
          avatarData,
          incomingQuickMessage.emotion,
          incomingQuickMessage.intensity,
          false
        );

        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // 50% scale
        const scale = 0.5;
        const charW = Math.round(rendered.canvas.width * scale);
        const charH = Math.round(rendered.canvas.height * scale);
        const scaledHeadX = Math.round(rendered.headX * scale);
        const scaledHeadY = Math.round(rendered.headY * scale);

        // Calculate balloon text dimensions
        ctx.font = `bold 12px ${COMIC_FONT_FAMILY}`;
        const lines = ComicLayoutEngine.getWrappedLines(ctx, incomingQuickMessage.text, 220);
        const lineHeight = 16;
        let maxLineW = 60;
        for (const line of lines) {
          const w = ctx.measureText(line.trim()).width;
          if (w > maxLineW) maxLineW = w;
        }

        const bW = Math.max(120, Math.min(260, Math.round(maxLineW + 36)));
        const bH = Math.max(42, lines.length * lineHeight + 24);

        // Size canvas to hold both balloon above and character below
        const canvasW = Math.max(bW + 28, charW + 40);
        const bX = Math.round((canvasW - bW) / 2);
        const bY = 8; // near top of canvas

        const charX = Math.round((canvasW - charW) / 2);
        const charY = bY + bH + 20; // placed cleanly below balloon to avoid covering head
        const canvasH = charY + charH + 10;

        setDimensions({ width: canvasW, height: canvasH });

        // Update canvas sizing directly
        canvas.width = canvasW;
        canvas.height = canvasH;

        ctx.clearRect(0, 0, canvasW, canvasH);

        // Draw avatar at 50% scale
        ctx.drawImage(rendered.canvas, charX, charY, charW, charH);

        // Draw Comic Word Balloon with tail pointing near avatar's head without covering it
        const tailX = charX + scaledHeadX;
        const tailY = charY + scaledHeadY - 4;

        const balloon: ComicBalloon = {
          id: `qm-${incomingQuickMessage.id}`,
          speakerParticipantId: incomingQuickMessage.senderParticipantId,
          speakerName: incomingQuickMessage.senderScreenName,
          text: incomingQuickMessage.text,
          mode: 'say',
          x: bX,
          y: bY,
          width: bW,
          height: bH,
          tailX,
          tailY,
        };

        ComicLayoutEngine.drawBalloon(ctx, balloon);
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
          filter: 'drop-shadow(0 6px 20px rgba(0,0,0,0.38))',
        }}
      >
        {/* Transparent canvas with 50% scale avatar & authentic comic word balloon */}
        <canvas
          ref={canvasRef}
          width={dimensions.width}
          height={dimensions.height}
          style={{ display: 'block', pointerEvents: 'none' }}
        />

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
