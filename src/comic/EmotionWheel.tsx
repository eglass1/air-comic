import React, { useState, useRef, useEffect } from 'react';
import {
  Box,
  Typography,
  Paper,
  IconButton,
  Tooltip,
  ButtonGroup,
  Button,
} from '@mui/material';
import WavingHandIcon from '@mui/icons-material/WavingHand';
import PanToolAltIcon from '@mui/icons-material/PanToolAlt';
import PersonPinIcon from '@mui/icons-material/PersonPin';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import SentimentSatisfiedAltIcon from '@mui/icons-material/SentimentSatisfiedAlt';
import {
  EM_HAPPY,
  EM_COY,
  EM_BORED,
  EM_SCARED,
  EM_SAD,
  EM_ANGRY,
  EM_SHOUT,
  EM_LAUGH,
  EM_NEUTRAL,
  EM_WAVE,
  EM_POINTOTHER,
  EM_POINTSELF,
  EM_SHRUG,
  AvatarData,
} from './types';
import { AvatarManager } from './avatarManager';
import { COMIC_FONT_FAMILY } from './comicLayout';

interface EmotionWheelProps {
  avatarName: string;
  selectedEmotion: number;
  selectedIntensity: number;
  onChangeEmotion: (emotion: number, intensity: number) => void;
}

const EMOTION_SECTORS = [
  { angle: EM_HAPPY, name: 'Happy', label: '😊 Happy' },
  { angle: EM_COY, name: 'Coy', label: '😏 Coy' },
  { angle: EM_BORED, name: 'Bored', label: '😑 Bored' },
  { angle: EM_SCARED, name: 'Scared', label: '😨 Scared' },
  { angle: EM_SAD, name: 'Sad', label: '😢 Sad' },
  { angle: EM_ANGRY, name: 'Angry', label: '😠 Angry' },
  { angle: EM_SHOUT, name: 'Shout', label: '📢 Shout' },
  { angle: EM_LAUGH, name: 'Laugh', label: '😂 Laugh' },
];

export const EmotionWheel: React.FC<EmotionWheelProps> = ({
  avatarName,
  selectedEmotion,
  selectedIntensity,
  onChangeEmotion,
}) => {
  const wheelCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const isDraggingRef = useRef<boolean>(false);
  const [avatarData, setAvatarData] = useState<AvatarData | null>(null);

  const WHEEL_SIZE = 140;
  const CENTER = WHEEL_SIZE / 2;
  const RADIUS = CENTER - 6;

  // Load avatar for preview
  useEffect(() => {
    let isMounted = true;
    AvatarManager.getInstance()
      .loadAvatar(avatarName)
      .then((data) => {
        if (isMounted && data) {
          setAvatarData(data);
        }
      });
    return () => {
      isMounted = false;
    };
  }, [avatarName]);

  // Draw the Emotion Wheel
  useEffect(() => {
    const canvas = wheelCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, WHEEL_SIZE, WHEEL_SIZE);

    // Outer ring & background
    ctx.beginPath();
    ctx.arc(CENTER, CENTER, RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#222222';
    ctx.stroke();

    // 8 Emotion Sectors
    const numSectors = 8;
    const sectorAngle = (Math.PI * 2) / numSectors;

    const sectorColors = [
      '#fff59d', // Happy (yellow)
      '#ffe082', // Coy (gold)
      '#b0bec5', // Bored (grey/blue)
      '#b3e5fc', // Scared (cyan)
      '#90caf9', // Sad (blue)
      '#ffab91', // Angry (red/orange)
      '#ff8a80', // Shout (red)
      '#a5d6a7', // Laugh (green)
    ];

    for (let i = 0; i < numSectors; i++) {
      const startAngle = i * sectorAngle - sectorAngle / 2;
      const endAngle = startAngle + sectorAngle;

      ctx.beginPath();
      ctx.moveTo(CENTER, CENTER);
      ctx.arc(CENTER, CENTER, RADIUS - 2, startAngle, endAngle);
      ctx.closePath();
      ctx.fillStyle = sectorColors[i];
      ctx.globalAlpha = 0.45;
      ctx.fill();
      ctx.globalAlpha = 1.0;

      // Divider lines
      ctx.beginPath();
      ctx.moveTo(CENTER, CENTER);
      ctx.lineTo(
        CENTER + Math.cos(startAngle) * (RADIUS - 2),
        CENTER + Math.sin(startAngle) * (RADIUS - 2)
      );
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#cccccc';
      ctx.stroke();
    }

    // Sector Labels
    const labelNames = ['Happy', 'Coy', 'Bored', 'Scared', 'Sad', 'Angry', 'Shout', 'Laugh'];
    ctx.font = `bold 8.5px ${COMIC_FONT_FAMILY}`;
    ctx.fillStyle = '#222222';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let i = 0; i < numSectors; i++) {
      const midAngle = i * sectorAngle;
      const lx = CENTER + Math.cos(midAngle) * (RADIUS * 0.68);
      const ly = CENTER + Math.sin(midAngle) * (RADIUS * 0.68);
      ctx.fillText(labelNames[i], lx, ly);
    }

    // Center Neutral Dot
    ctx.beginPath();
    ctx.arc(CENTER, CENTER, 12, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#333333';
    ctx.stroke();

    ctx.font = '7.5px sans-serif';
    ctx.fillStyle = '#555555';
    ctx.fillText('Neutral', CENTER, CENTER);

    // Selected Target Indicator Dot
    let selX = CENTER;
    let selY = CENTER;
    let showDot = false;
    if (selectedEmotion < 10 && selectedIntensity > 0) {
      selX = CENTER + Math.cos(selectedEmotion) * (selectedIntensity * (RADIUS - 10));
      selY = CENTER + Math.sin(selectedEmotion) * (selectedIntensity * (RADIUS - 10));
      showDot = true;
    }

    if (showDot) {
      // Draw Crosshair & Target Dot
      ctx.beginPath();
      ctx.arc(selX, selY, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#ff1744';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    }
  }, [selectedEmotion, selectedIntensity]);

  // Draw Live Character Preview
  useEffect(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas || !avatarData) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const rendered = AvatarManager.getInstance().renderCharacter(
      avatarData,
      selectedEmotion,
      selectedIntensity,
      false
    );

    // Center and scale character in preview canvas
    const scale = Math.min(
      (canvas.width - 8) / rendered.canvas.width,
      (canvas.height - 8) / rendered.canvas.height
    );
    const dw = rendered.canvas.width * scale;
    const dh = rendered.canvas.height * scale;
    const dx = (canvas.width - dw) / 2;
    const dy = (canvas.height - dh) / 2;

    ctx.drawImage(rendered.canvas, dx, dy, dw, dh);
  }, [avatarData, selectedEmotion, selectedIntensity]);

  const updateFromPointer = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    const canvas = wheelCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;

    const x = clientX - rect.left - CENTER;
    const y = clientY - rect.top - CENTER;
    const dist = Math.sqrt(x * x + y * y);

    if (dist < 12) {
      // Center neutral
      onChangeEmotion(EM_NEUTRAL, 0.0);
      return;
    }

    let angle = Math.atan2(y, x);
    if (angle < 0) angle += Math.PI * 2;

    const intensity = Math.min(1.0, Math.max(0.1, dist / (RADIUS - 10)));
    onChangeEmotion(angle, intensity);
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    isDraggingRef.current = true;
    updateFromPointer(e);
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isDraggingRef.current) {
      updateFromPointer(e);
    }
  };

  const handleMouseUp = () => {
    isDraggingRef.current = false;
  };

  return (
    <Box
      sx={{
        p: 1.5,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 1,
        bgcolor: 'background.paper',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        {/* Emotion Wheel Canvas */}
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <Typography variant="caption" sx={{ fontWeight: 800, mb: 0.5, color: 'text.secondary' }}>
            EMOTION WHEEL
          </Typography>
          <canvas
            ref={wheelCanvasRef}
            width={WHEEL_SIZE}
            height={WHEEL_SIZE}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onTouchStart={updateFromPointer}
            onTouchMove={updateFromPointer}
            style={{
              cursor: 'crosshair',
              borderRadius: '50%',
              boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
            }}
          />
        </Box>

        {/* Live Character Face / Pose Preview */}
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <Typography variant="caption" sx={{ fontWeight: 800, mb: 0.5, color: 'text.secondary' }}>
            {avatarData?.name || avatarName}
          </Typography>
          <Box
            sx={{
              width: 100,
              height: 100,
              border: '2px solid',
              borderColor: 'primary.main',
              borderRadius: 2,
              bgcolor: '#fffef9',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
            }}
          >
            <canvas ref={previewCanvasRef} width={100} height={100} />
          </Box>
          <Button
            size="small"
            variant="text"
            onClick={() => onChangeEmotion(EM_NEUTRAL, 0.0)}
            sx={{ mt: 0.5, fontSize: '0.7rem', py: 0 }}
          >
            Reset Neutral
          </Button>
        </Box>
      </Box>

      {/* Special Gestures Bar */}
      <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', justifyContent: 'center' }}>
        <Tooltip title="Wave / Greeting">
          <IconButton
            size="small"
            color={selectedEmotion === EM_WAVE ? 'primary' : 'default'}
            onClick={() => onChangeEmotion(EM_WAVE, 1.0)}
            sx={{ border: '1px solid', borderColor: 'divider' }}
          >
            <WavingHandIcon fontSize="small" />
          </IconButton>
        </Tooltip>

        <Tooltip title="Point at Other">
          <IconButton
            size="small"
            color={selectedEmotion === EM_POINTOTHER ? 'primary' : 'default'}
            onClick={() => onChangeEmotion(EM_POINTOTHER, 1.0)}
            sx={{ border: '1px solid', borderColor: 'divider' }}
          >
            <PanToolAltIcon fontSize="small" />
          </IconButton>
        </Tooltip>

        <Tooltip title="Point at Self">
          <IconButton
            size="small"
            color={selectedEmotion === EM_POINTSELF ? 'primary' : 'default'}
            onClick={() => onChangeEmotion(EM_POINTSELF, 1.0)}
            sx={{ border: '1px solid', borderColor: 'divider' }}
          >
            <PersonPinIcon fontSize="small" />
          </IconButton>
        </Tooltip>

        <Tooltip title="Shrug / Confused">
          <IconButton
            size="small"
            color={selectedEmotion === EM_SHRUG ? 'primary' : 'default'}
            onClick={() => onChangeEmotion(EM_SHRUG, 1.0)}
            sx={{ border: '1px solid', borderColor: 'divider' }}
          >
            <HelpOutlineIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
    </Box>
  );
};
