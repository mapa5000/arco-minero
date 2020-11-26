
require([
  "esri/Map",

  "esri/core/Handles",

  "esri/views/MapView",
  "esri/views/2d/layers/BaseLayerView2D",

  "esri/layers/Layer",
  "esri/layers/FeatureLayer",
  "esri/layers/support/TileInfo",

  "esri/geometry/projection",
  "esri/geometry/Polygon",

  "esri/widgets/Slider",

  "esri/core/watchUtils"
], function (
  Map,
  Handles,
  MapView,
  BaseLayerView2D,
  Layer,
  FeatureLayer,
  TileInfo,
  projection,
  Polygon,
  Slider,
  watchUtils
) {
  const CustomLayerView2D = BaseLayerView2D.createSubclass({
    constructor: function () {
      // Maps from tile id to the image used by that tile.
      this.tileContexts = new window.Map();

      // The handles to the property watchers; we need to store them
      // so that we can unwatch the properties when the layer view
      // is detached.
      this.watchHandles = new Handles();

      // Set to true when the images in the tiles have become obsolete
      // and must be regenerated. This is triggered by a change of
      // layer.geometry, layer.color or layer.distance.
      this.needsImageUpdate = false;
    },

    // Called when the layer is added to the map.
    attach: function () {
      const projectionPromise = projection.load();
      const layerView = this;
      const layer = layerView.layer;

      this.watchHandles.add([
        watchUtils.init(this, "layer.geometry", function () {
          if (!layer.geometry) {
            layerView.projectedGeometry = null;
            layerView.needsImageUpdate = true;
            layerView.requestRender();
            return;
          }

          projectionPromise.then(function () {
            layerView.projectedGeometry = projection.project(
              layer.geometry,
              layer.tileInfo.spatialReference,
              projection.getTransformation(
                layer.geometry.spatialReference,
                layer.tileInfo.spatialReference
              )
            );
            layerView.needsImageUpdate = true;
            layerView.requestRender();
          });
        }),

        watchUtils.init(this, "layer.distance", function () {
          layerView.needsImageUpdate = true;
          layerView.requestRender();
        }),

        watchUtils.init(this, "layer.color", function () {
          layerView.needsImageUpdate = true;
          layerView.requestRender();
        })
      ]);
    },

    // Called to regenerate a tile.
    drawGeometry: function (ctx, bounds) {
      ctx.globalCompositeOperation = "source-over";
      const width = ctx.canvas.width;
      const height = ctx.canvas.height;

      // No geometry; entire map is unmasked.
      if (!this.projectedGeometry) {
        ctx.clearRect(0, 0, width, height);
        return;
      }

      if (this.layer.distance === 0) {
        return;
      }

      // We mask the entire map; we will "carve" the unmasked area using
      // an operation that subtracts opacity iteratively.
      const c = this.layer.color;
      ctx.fillStyle = "rgba(" + c[0] + ", " + c[1] + ", " + c[2] + ", 1)";
      ctx.fillRect(0, 0, width, height);

      // Every iteration reduces opacity by a constant term and each iteration acts
      // on a progressively smaller region.
      // The factor "3" is fairly arbitrary, but it works well with "destination-out".
      // Lower values would cause a visible discontinuity between the fully illuminated
      // area and the beginning of the shaded area.
      const unmaskTerm = 3 / this.layer.distance;
      ctx.globalCompositeOperation = "destination-out";

      if (
        this.projectedGeometry.type === "polygon" ||
        this.projectedGeometry.type === "polyline" ||
        this.projectedGeometry.type === "extent"
      ) {
        // Polygons, polylines and extents are carved using increasingly thinner lines
        // and a single fill operation at the end.

        // All geometry types are treated as rings.
        const rings =
          this.projectedGeometry.type === "extent"
            ? Polygon.fromExtent(this.projectedGeometry).rings
            : this.projectedGeometry.rings ||
              this.projectedGeometry.paths;

        // Rings are transformed to tile coordinates.
        const transformed = rings.map(function (ring) {
          return ring.map(function (coords) {
            return [
              Math.round(
                (width * (coords[0] - bounds[0])) /
                  (bounds[2] - bounds[0])
              ),
              Math.round(
                height *
                  (1 - (coords[1] - bounds[1]) / (bounds[3] - bounds[1]))
              )
            ];
          });
        });

        // The rings are drawn as increasingly thinner lines; this produces
        // a blurred edge around the unmasked area, so that transition from
        // unmasked to masked is gradual.
        ctx.lineJoin = "round";

        for (let r = 1; r <= this.layer.distance; ++r) {
          ctx.strokeStyle = "rgba(0, 0, 0, " + unmaskTerm + ")";
          ctx.lineWidth = this.layer.distance + 1 - r;

          for (let i = 0; i < transformed.length; ++i) {
            const ring = transformed[i];

            ctx.beginPath();
            ctx.moveTo(ring[0][0], ring[0][1]);

            for (let j = 1; j < ring.length; ++j) {
              ctx.lineTo(ring[j][0], ring[j][1]);
            }

            // If it's not a polyline, meaning it's a polygon or an extent,
            // we close the path.
            this.projectedGeometry.type !== "polyline" && ctx.closePath();
            ctx.stroke();
          }
        }

        if (this.projectedGeometry.type !== "polyline") {
          // If it's not a polyline, meaning it's a polygon or an extent,
          // we carve the space occupied by the geometry using a fill
          // operation; this is what fully unmask the geometry.
          ctx.fillStyle = "rgba(0, 0, 0, 1)";

          for (let i = 0; i < transformed.length; ++i) {
            const ring = transformed[i];

            ctx.beginPath();
            ctx.moveTo(ring[0][0], ring[0][1]);

            for (let j = 1; j < ring.length; ++j) {
              ctx.lineTo(ring[j][0], ring[j][1]);
            }

            ctx.closePath();
            ctx.fill();
          }
        }
      } else if (
        this.projectedGeometry.type === "point" ||
        this.projectedGeometry.type === "multipoint"
      ) {
        // Points an multipoints are carved using increasingly smaller circles.

        // The "point" case is equivalent to a "multipoint" with a single point.
        const points =
          this.projectedGeometry.type === "multipoint"
            ? this.projectedGeometry.points
            : [[this.projectedGeometry.x, this.projectedGeometry.y]];

        // Points are transformed to tile coordinates.
        const transformed = points.map(function (coords) {
          return [
            Math.round(
              (width * (coords[0] - bounds[0])) / (bounds[2] - bounds[0])
            ),
            Math.round(
              height *
                (1 - (coords[1] - bounds[1]) / (bounds[3] - bounds[1]))
            )
          ];
        });

        // The points are drawn using increasingly smaller circles.
        for (let r = 1; r <= this.layer.distance; ++r) {
          const size = this.layer.distance + 1 - r;
          ctx.fillStyle = "rgba(0, 0, 0, " + unmaskTerm + ")";

          for (let i = 0; i < transformed.length; ++i) {
            const point = transformed[i];
            ctx.beginPath();
            ctx.arc(point[0], point[1], Math.round(size / 2), 0, 360);
            ctx.fill();
          }
        }
      }
    },

    // Creates the images for new tiles that don't have a texture yet, and destroys the images
    // of tiles that are not on screen anymore.
    manageTileImages: function () {
      const gl = this.context;

      const tileIdSet = new Set();

      // Create new images as needed.
      for (let i = 0; i < this.tiles.length; ++i) {
        const tile = this.tiles[i];
        tileIdSet.add(tile.id);

        let ctx = this.tileContexts.get(tile.id);

        if (ctx) {
          if (this.needsImageUpdate) {
            this.drawGeometry(ctx, tile.bounds);
          }
        } else {
          const canvas = document.createElement("canvas");
          canvas.width = this.layer.tileInfo.size[0];
          canvas.height = this.layer.tileInfo.size[1];
          ctx = canvas.getContext("2d");
          this.tileContexts.set(tile.id, ctx);
          this.drawGeometry(ctx, tile.bounds);
        }
      }

      // Destroys unneeded images.
      this.tileContexts.forEach(
        function (_, id) {
          if (!tileIdSet.has(id)) {
            this.tileContexts.delete(id);
          }
        }.bind(this)
      );

      this.needsImageUpdate = false;
    },

    // Example of a render implementation that draws tile boundaries.
    render: function (renderParameters) {
      this.manageTileImages();

      const tileSize = this.layer.tileInfo.size[0];
      const state = renderParameters.state;
      const pixelRatio = state.pixelRatio;
      const width = state.size[0];
      const height = state.size[1];
      const context = renderParameters.context;
      const coords = [0, 0];

      context.clearRect(0, 0, width * pixelRatio, height * pixelRatio);

      // Apply rotation for everything that will be applied to the canvas.
      if (state.rotation !== 0) {
        context.translate(
          width * pixelRatio * 0.5,
          height * pixelRatio * 0.5
        );
        context.rotate((state.rotation * Math.PI) / 180);
        context.translate(
          -width * pixelRatio * 0.5,
          -height * pixelRatio * 0.5
        );
      }

      // Set the style for all the text.
      context.globalAlpha = this.layer.color[3];

      for (let i = 0; i < this.tiles.length; ++i) {
        // Retrieve the current tile and its associated texture.
        const tile = this.tiles[i];
        const ctx = this.tileContexts.get(tile.id);

        const screenScale =
          (tile.resolution / state.resolution) * pixelRatio;
        state.toScreenNoRotation(coords, tile.coords);
        context.drawImage(
          ctx.canvas,
          coords[0],
          coords[1],
          tileSize * screenScale,
          tileSize * screenScale
        );
      }
    },

    // Destroy the shader program, the buffers and all the tile images.
    detach: function () {
      this.watchHandles.removeAll();
    },

    // Required when using tiling; this methods is called every time that `this.tiles`
    // changes, to give the derived class a chance to perform per-tile work as needed;
    // This is where, for instance, tile data could be fetched from a server.
    tilesChanged: function () {}
  });

  const CustomLayer = Layer.createSubclass({
    tileInfo: TileInfo.create({
      size: 512,
      spatialReference: { wkid: 3857 }
    }),

    constructor: function () {
      this.color = [0, 0, 0, 1];
      this.distance = 10;
    },

    createLayerView: function (view) {
      if (view.type === "2d") {
        return new CustomLayerView2D({
          view: view,
          layer: this
        });
      }
    },

    properties: {
      color: {},
      geometry: {},
      distance: {}
    }
  });

  const layer = new CustomLayer({
    color: [0, 0, 0, 0.8]
  });

  const map = new Map({
    basemap: "satellite",
    layers: [layer]
  });

  const view = new MapView({
    container: "viewDiv",
    map: map,
    zoom: 3
  });

  const countries = new FeatureLayer({
    url:
      "https://services3.arcgis.com/U26uBjSD32d7xvm2/arcgis/rest/services/Arco_minero_merge/FeatureServer"
  });

  let running = true;

  const query = countries.createQuery();
  query.where = "ISO = 'IT'";
  countries.queryFeatures(query).then(function (result) {
    const geometry = result.features[0].geometry;
    layer.geometry = geometry;
    view.goTo(geometry).catch(function (error) {
      if (error.name != "AbortError") {
        console.error(error);
      }
    });
  });

  const slider = new Slider({
    container: "sliderDiv",
    min: 0,
    max: 50,
    values: [25],
    visibleElements: {
      labels: true,
      rangeLabels: true
    }
  });

  slider.on("thumb-drag", function (event) {
    layer.distance = event.value;
  });

  view.ui.add("controls", "top-right");
});