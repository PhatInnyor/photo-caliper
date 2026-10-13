@echo off
REM Photo Caliper - COLMAP pipeline (GTX 1650 4GB friendly)
REM Put this file next to the "images" folder and refs.json, then double-click.
setlocal
set COLMAP=colmap
where %COLMAP% >nul 2>nul || set COLMAP=C:\COLMAP\COLMAP.bat
set WS=%~dp0
cd /d "%WS%"
if not exist images (echo [ERR] images folder not found & pause & exit /b 1)
mkdir sparse 2>nul
mkdir dense 2>nul
echo [1/8] Feature extraction (GPU)
%COLMAP% feature_extractor --database_path db.db --image_path images --ImageReader.camera_model OPENCV --ImageReader.single_camera 1 --SiftExtraction.use_gpu 1 --SiftExtraction.max_image_size 3200 || goto err
echo [2/8] Matching
%COLMAP% exhaustive_matcher --database_path db.db --SiftMatching.use_gpu 1 || goto err
echo [3/8] Sparse reconstruction
%COLMAP% mapper --database_path db.db --image_path images --output_path sparse || goto err
echo [4/8] Undistort
%COLMAP% image_undistorter --image_path images --input_path sparse\0 --output_path dense --output_type COLMAP --max_image_size 1600 || goto err
echo [5/8] Dense stereo (slow; 4GB VRAM -> 1600 px)
%COLMAP% patch_match_stereo --workspace_path dense --workspace_format COLMAP --PatchMatchStereo.geom_consistency true --PatchMatchStereo.max_image_size 1600 || goto err
echo [6/8] Fusion
%COLMAP% stereo_fusion --workspace_path dense --workspace_format COLMAP --input_type geometric --output_path dense\fused.ply || goto err
echo [7/8] Poisson mesh
%COLMAP% poisson_mesher --input_path dense\fused.ply --output_path dense\meshed-poisson.ply || goto err
echo [8/8] Scale to millimetres
mkdir sparse_txt 2>nul
%COLMAP% model_converter --input_path sparse\0 --output_path sparse_txt --output_type TXT || goto err
python scale_model.py || goto err
echo.
echo Done. Open dense\meshed-poisson_mm.ply (or fused_mm.ply) in Photo Caliper 3D tab.
pause
exit /b 0
:err
echo [ERR] step failed. See messages above.
pause
exit /b 1
