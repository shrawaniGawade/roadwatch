'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Defect, Road } from '@roadwatch/domain';
import { Expand, Layers, LocateFixed, Minus, Plus } from 'lucide-react';
import type { Map as MapInstance, Marker, GeoJSONSource } from 'maplibre-gl';

const priorityColors: Record<string, string> = {
  P0: '#c73d2a',
  P1: '#ed792d',
  P2: '#d7a637',
  P3: '#3f7cbb',
};
type Props = {
  roads: Road[];
  defects: Defect[];
  selectedId?: string;
  onSelect: (defect: Defect) => void;
  demo?: boolean;
  compact?: boolean;
  onPick?: (point: { latitude: number; longitude: number }) => void;
  pickedPoint?: { latitude: number; longitude: number } | null;
};

export default function RoadMap({
  roads,
  defects,
  selectedId,
  onSelect,
  demo = false,
  compact = false,
  onPick,
  pickedPoint,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapInstance | null>(null);
  const markers = useRef<Marker[]>([]);
  const [ready, setReady] = useState(false);
  const [fallback, setFallback] = useState(false);
  const [showDefects, setShowDefects] = useState(true);
  const callback = useRef(onSelect);
  callback.current = onSelect;
  const pickCallback = useRef(onPick);
  pickCallback.current = onPick;
  const bounds = useMemo(() => {
    const points = roads.flatMap((r) => r.geometry.coordinates);
    if (!points.length) return [78.37, 17.41, 78.42, 17.45] as const;
    return [
      Math.min(...points.map((p) => p[0])),
      Math.min(...points.map((p) => p[1])),
      Math.max(...points.map((p) => p[0])),
      Math.max(...points.map((p) => p[1])),
    ] as const;
  }, [roads]);
  const fit = () =>
    map.current?.fitBounds(
      [
        [bounds[0], bounds[1]],
        [bounds[2], bounds[3]],
      ],
      { padding: compact ? 45 : 85, maxZoom: 16, duration: 500 },
    );

  useEffect(() => {
    if (!container.current) return;
    let disposed = false;
    void import('maplibre-gl')
      .then(({ Map }) => {
        if (disposed || !container.current) return;
        try {
          const tileUrl = process.env.NEXT_PUBLIC_MAP_STYLE_URL;
          const instance = new Map({
            container: container.current,
            style: tileUrl || {
              version: 8,
              sources: {},
              layers: [
                { id: 'background', type: 'background', paint: { 'background-color': '#eaf0f1' } },
              ],
            },
            center: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2],
            zoom: 13.3,
            attributionControl: { compact: true },
            maxZoom: 20,
          });
          map.current = instance;
          instance.on('load', () => {
            if (!disposed) setReady(true);
          });
          instance.on('click', (event) =>
            pickCallback.current?.({
              latitude: Number(event.lngLat.lat.toFixed(7)),
              longitude: Number(event.lngLat.lng.toFixed(7)),
            }),
          );
          const observer = new ResizeObserver(() => instance.resize());
          observer.observe(container.current);
          instance.on('remove', () => observer.disconnect());
        } catch {
          setFallback(true);
        }
      })
      .catch(() => setFallback(true));
    return () => {
      disposed = true;
      map.current?.remove();
      map.current = null;
      setReady(false);
    };
    // One map instance; network geometry is updated independently below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const instance = map.current;
    if (!ready || !instance) return;
    const roadData = {
      type: 'FeatureCollection' as const,
      features: roads.map((road) => ({
        type: 'Feature' as const,
        geometry: road.geometry,
        properties: { id: road.id, name: road.name },
      })),
    };
    const source = instance.getSource('survey-roads');
    if (source) (source as GeoJSONSource).setData(roadData);
    else {
      instance.addSource('survey-roads', { type: 'geojson', data: roadData });
      instance.addLayer({
        id: 'road-casing',
        type: 'line',
        source: 'survey-roads',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#c4ced5', 'line-width': 15 },
      });
      instance.addLayer({
        id: 'road-surface',
        type: 'line',
        source: 'survey-roads',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 12 },
      });
      instance.addLayer({
        id: 'road-centerline',
        type: 'line',
        source: 'survey-roads',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#a9bfce', 'line-width': 1.5, 'line-dasharray': [3, 3] },
      });
    }
    if (demo && !instance.getSource('demo-context')) {
      const [west, south, east, north] = bounds;
      const dx = east - west || 0.04;
      const dy = north - south || 0.04;
      const context = Array.from({ length: 11 }, (_, n) => [
        {
          type: 'Feature' as const,
          properties: {},
          geometry: {
            type: 'LineString' as const,
            coordinates: [
              [west - dx / 2, south + (dy * n) / 8],
              [east + dx / 2, south + (dy * n) / 8 - dy * 0.08],
            ],
          },
        },
        {
          type: 'Feature' as const,
          properties: {},
          geometry: {
            type: 'LineString' as const,
            coordinates: [
              [west + (dx * n) / 8, south - dy / 2],
              [west + (dx * n) / 8 + dx * 0.1, north + dy / 2],
            ],
          },
        },
      ]).flat();
      instance.addSource('demo-context', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: context },
      });
      instance.addLayer(
        {
          id: 'demo-context-lines',
          type: 'line',
          source: 'demo-context',
          paint: { 'line-color': '#ffffff', 'line-width': 5, 'line-opacity': 0.8 },
        },
        'road-casing',
      );
    }
    fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, roads, demo]);

  useEffect(() => {
    const instance = map.current;
    if (!ready || !instance) return;
    let disposed = false;
    markers.current.forEach((marker) => marker.remove());
    markers.current = [];
    void import('maplibre-gl').then(({ Marker }) => {
      if (disposed) return;
      if (showDefects)
        defects.forEach((defect) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = `map-defect ${selectedId === defect.id ? 'selected' : ''}`;
          button.style.setProperty(
            '--pin-color',
            priorityColors[defect.priority] || priorityColors.P3,
          );
          button.textContent = defect.priority.replace('P', '');
          button.setAttribute(
            'aria-label',
            `${defect.code}: ${defect.type.replaceAll('_', ' ')}, ${defect.priority}`,
          );
          button.onclick = () => callback.current(defect);
          markers.current.push(
            new Marker({ element: button })
              .setLngLat([defect.longitude, defect.latitude])
              .addTo(instance),
          );
        });
      roads.slice(0, 7).forEach((road) => {
        const position =
          road.geometry.coordinates[Math.floor(road.geometry.coordinates.length / 2)];
        if (!position) return;
        const label = document.createElement('span');
        label.className = 'map-road-label';
        label.textContent = road.name;
        markers.current.push(
          new Marker({ element: label, anchor: 'bottom', offset: [0, -20] })
            .setLngLat(position)
            .addTo(instance),
        );
      });
    });
    return () => {
      disposed = true;
      markers.current.forEach((marker) => marker.remove());
    };
  }, [ready, defects, roads, selectedId, showDefects]);

  useEffect(() => {
    const selected = defects.find((d) => d.id === selectedId);
    if (selected && map.current)
      map.current.easeTo({ center: [selected.longitude, selected.latitude], duration: 600 });
  }, [selectedId, defects]);

  useEffect(() => {
    const instance = map.current;
    if (!ready || !instance) return;
    const pointData = {
      type: 'FeatureCollection' as const,
      features: pickedPoint
        ? [
            {
              type: 'Feature' as const,
              properties: {},
              geometry: {
                type: 'Point' as const,
                coordinates: [pickedPoint.longitude, pickedPoint.latitude],
              },
            },
          ]
        : [],
    };
    const source = instance.getSource('picked-observation');
    if (source) (source as GeoJSONSource).setData(pointData);
    else {
      instance.addSource('picked-observation', { type: 'geojson', data: pointData });
      instance.addLayer({
        id: 'picked-observation-point',
        type: 'circle',
        source: 'picked-observation',
        paint: {
          'circle-radius': 9,
          'circle-color': '#285ddd',
          'circle-stroke-width': 3,
          'circle-stroke-color': '#fff',
        },
      });
    }
  }, [ready, pickedPoint]);

  const toXY = (coordinate: number[]) => [
    60 + ((coordinate[0] - bounds[0]) / (bounds[2] - bounds[0] || 0.01)) * 680,
    450 - ((coordinate[1] - bounds[1]) / (bounds[3] - bounds[1] || 0.01)) * 370,
  ];
  return (
    <div className={`road-map ${compact ? 'compact' : ''}`}>
      <div ref={container} className="map-canvas" aria-label="Interactive road condition map" />
      {fallback && (
        <svg
          className="map-fallback"
          viewBox="0 0 800 500"
          role="img"
          aria-label="Road network diagram; interactive map rendering unavailable"
        >
          <defs>
            <pattern id="grid" width="70" height="60" patternUnits="userSpaceOnUse">
              <path d="M70 0H0V60" fill="none" stroke="#fff" strokeWidth="5" />
            </pattern>
          </defs>
          <rect width="800" height="500" fill={demo ? 'url(#grid)' : '#eaf0f1'} />
          {roads.map((road) => (
            <g key={road.id}>
              <polyline
                points={road.geometry.coordinates
                  .map(toXY)
                  .map((p) => p.join(','))
                  .join(' ')}
                fill="none"
                stroke="#b6c8d3"
                strokeWidth="13"
                strokeLinecap="round"
              />
              <polyline
                points={road.geometry.coordinates
                  .map(toXY)
                  .map((p) => p.join(','))
                  .join(' ')}
                fill="none"
                stroke="white"
                strokeWidth="9"
                strokeLinecap="round"
              />
            </g>
          ))}
          {showDefects &&
            defects.map((defect) => {
              const [x, y] = toXY([defect.longitude, defect.latitude]);
              return (
                <circle
                  key={defect.id}
                  cx={x}
                  cy={y}
                  r={selectedId === defect.id ? 12 : 9}
                  fill={priorityColors[defect.priority]}
                  stroke="white"
                  strokeWidth="3"
                />
              );
            })}
        </svg>
      )}
      <div className="map-title">
        <span className="live-dot" />
        Road condition layer
        <button onClick={() => setShowDefects(!showDefects)} aria-pressed={showDefects}>
          <Layers size={15} />
          {showDefects ? 'Hide defects' : 'Show defects'}
        </button>
      </div>
      <div className="map-controls">
        <button aria-label="Zoom in" disabled={fallback} onClick={() => map.current?.zoomIn()}>
          <Plus size={18} />
        </button>
        <button aria-label="Zoom out" disabled={fallback} onClick={() => map.current?.zoomOut()}>
          <Minus size={18} />
        </button>
        <button aria-label="Fit road network" disabled={fallback} onClick={fit}>
          <Expand size={17} />
        </button>
      </div>
      <div className="map-legend">
        <span>
          <i style={{ background: priorityColors.P0 }} />
          Immediate
        </span>
        <span>
          <i style={{ background: priorityColors.P1 }} />
          High
        </span>
        <span>
          <i style={{ background: priorityColors.P2 }} />
          Medium
        </span>
        <span>
          <i style={{ background: priorityColors.P3 }} />
          Routine
        </span>
      </div>
      <div className="map-attribution">
        <LocateFixed size={12} />
        {demo ? 'Illustrative demo geometry · not an official map' : 'Organization road geometry'}
        {fallback ? ' · diagram view' : ''}
      </div>
    </div>
  );
}
