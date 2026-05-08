$env:FILTER_BRANCH_SQUELCH_WARNING=1

git filter-branch --env-filter @'
if [ "$GIT_AUTHOR_NAME" = "zhengkangyue" ]; then
    export GIT_AUTHOR_NAME=""
fi
if [ "$GIT_AUTHOR_EMAIL" = "zhengkangyue@example.com" ]; then
    export GIT_AUTHOR_EMAIL=""
fi
if [ "$GIT_COMMITTER_NAME" = "zhengkangyue" ]; then
    export GIT_COMMITTER_NAME=""
fi
if [ "$GIT_COMMITTER_EMAIL" = "zhengkangyue@example.com" ]; then
    export GIT_COMMITTER_EMAIL=""
fi
'@ -- --all